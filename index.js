/**
 * Cloudinary + Gemini Screenshot Analysis Script
 *
 * This script processes images from Cloudinary using Google's Gemini Vision API
 * to generate detailed descriptions, then stores those back in Cloudinary metadata.
 *
 * Features:
 * - Async processing with proper error handling
 * - Token usage tracking and cost estimation
 * - Detailed logging with Winston
 * - Skips previously processed images
 * - Generates detailed usage reports
 *
 * Required Environment Variables:
 * CLOUDINARY_CLOUD_NAME=your_cloud_name
 * CLOUDINARY_API_KEY=your_api_key
 * CLOUDINARY_API_SECRET=your_api_secret
 * GOOGLE_API_KEY=your_gemini_api_key
 */

import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs/promises";
import path from "path";
import winston from "winston";
import { promisify } from "util";
import fetch from "node-fetch";
import minimist from "minimist";
import LokiTransport from "winston-loki";
const express = require("express");
const app = express();

// Load environment variables and validate required ones
dotenv.config();

// Add global tracker
let globalTracker = null;

// Remove unused constants
const requiredEnvVars = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "GOOGLE_API_KEY",
];

// Check for missing environment variables before starting
const missingEnvVars = requiredEnvVars.filter(
  (varName) => !process.env[varName]
);
if (missingEnvVars.length > 0) {
  console.error("Missing required environment variables:", missingEnvVars);
  process.exit(1);
}

/**
 * Logging Configuration
 *
 * Levels: error, warn, info, debug
 * Files:
 * - error.log: Only error level logs
 * - debug.log: All logs including debug statements
 * - combined.log: Info and above
 */
const createLogger = () => {
  const transports = [
    // Keep existing file transports for local debugging
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
    }),
    new winston.transports.File({
      filename: "logs/combined.log",
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ];

  // Add Loki transport if configured
  if (process.env.LOKI_HOST) {
    const lokiConfig = {
      host: process.env.LOKI_HOST,
      basicAuth: process.env.LOKI_BASIC_AUTH,
      labels: {
        job: process.env.LOKI_JOB_NAME || "retroscope",
        component: process.env.LOKI_COMPONENT || "image-analysis",
        environment: process.env.LOKI_ENVIRONMENT || "production",
        service: "retroscope",
        version: process.env.npm_package_version || "unknown",
      },
      json: true,
      format: winston.format.json(),
      replaceTimestamp: true,
      interval: 5,
      batching: true,
      onConnectionError: (error) => {
        console.error("Loki connection error:", error);
      },
      // Reduce batching to debug more easily
      batchInterval: 1,
      maxBatchSize: 1,
      // Add these debug options
      debug: true,
      silentFail: false,
      flushOnExit: true,
      timeout: 5000, // Reduce timeout to fail faster
      retries: 1, // Reduce retries to fail faster
    };

    try {
      const lokiTransport = new LokiTransport(lokiConfig);

      lokiTransport.on("error", (error) => {
        console.error("Loki transport error:", error);
      });

      lokiTransport.on("logged", (info) => {
        console.log("Successfully sent to Loki:", {
          timestamp: info.timestamp,
          level: info.level,
          message: info.message?.substring(0, 50) + "...",
        });
      });

      // Add more event listeners for debugging
      lokiTransport.on("warn", (warning) => {
        console.warn("Loki transport warning:", warning);
      });

      lokiTransport.on("batch", (batch) => {
        console.log("Sending batch to Loki:", {
          size: batch.length,
          firstMessage: batch[0]?.message?.substring(0, 50) + "...",
        });
      });

      transports.push(lokiTransport);

      console.log("Attempting Loki connection with config:", {
        host: lokiConfig.host,
        job: lokiConfig.labels.job,
        component: lokiConfig.labels.component,
        environment: lokiConfig.labels.environment,
        batching: lokiConfig.batching,
        interval: lokiConfig.interval,
        batchInterval: lokiConfig.batchInterval,
        maxBatchSize: lokiConfig.maxBatchSize,
      });
    } catch (error) {
      console.error("Failed to initialize Loki transport:", error);
    }
  }

  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        // Add metrics labels for Grafana
        if (meta.event_type === "metric") {
          return JSON.stringify({
            timestamp,
            level,
            message,
            metric_name: meta.metric_name,
            metric_value: meta.metric_value,
            ...meta,
          });
        }
        return JSON.stringify({
          timestamp,
          level,
          message,
          ...meta,
        });
      })
    ),
    defaultMeta: {
      service: "retroscope",
      version: process.env.npm_package_version,
    },
    transports,
  });

  // Log Loki config AFTER logger is created
  if (process.env.LOKI_HOST) {
    logger.info("Loki transport configured", {
      host: process.env.LOKI_HOST,
      job: process.env.LOKI_JOB_NAME,
      component: process.env.LOKI_COMPONENT,
      environment: process.env.LOKI_ENVIRONMENT,
    });
  }

  return logger;
};

const logger = createLogger();

// Initialize Cloudinary with error handling
try {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  logger.info("Cloudinary initialized successfully");
} catch (error) {
  logger.error("Failed to initialize Cloudinary:", error);
  process.exit(1);
}

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

/**
 * TokenUsageTracker Class with detailed cost analysis
 */
class TokenUsageTracker {
  constructor() {
    this.totalTokens = 0;
    this.totalCost = 0;
    this.processedImages = 0;
    this.failedImages = 0;
    this.startTime = Date.now();
    this.details = []; // Store per-image details

    // Updated Gemini 1.5 Flash-8B pricing
    this.rates = {
      input: {
        text: 0.0005 / 1_000,
        image: 0.0005 / 1_000,
      },
      output: 0.0005 / 1_000,
    };
  }

  addUsage(imageData, description, success = true) {
    // Detect if it's likely a screenshot based on filename
    const isScreenshot = imageData.public_id
      .toLowerCase()
      .includes("screenshot");

    // Screenshots often need fewer tokens as they're more structured
    const imageTokens = isScreenshot
      ? Math.ceil(16384) // 16K for screenshots
      : Math.ceil(32768); // 32K for photos (might need more detail)

    const outputTokens = Math.ceil(description.length / 4);

    // Calculate costs using official rates
    const imageCost = imageTokens * this.rates.input.image;
    const outputTokenCost = outputTokens * this.rates.output;
    const totalCost = imageCost + outputTokenCost;

    // Update totals
    this.totalTokens += imageTokens + outputTokens;
    this.totalCost += totalCost;

    if (success) {
      this.processedImages += 1;
    } else {
      this.failedImages += 1;
    }

    // Store detailed breakdown
    const detail = {
      timestamp: new Date().toISOString(),
      imageId: imageData.public_id,
      success,
      tokens: {
        input: imageTokens,
        output: outputTokens,
        total: imageTokens + outputTokens,
      },
      costs: {
        image: Number(imageCost.toFixed(6)), // More decimal places for small amounts
        output: Number(outputTokenCost.toFixed(6)),
        total: Number(totalCost.toFixed(6)),
      },
      content: {
        wordCount: description.split(/\s+/).length,
        characterCount: description.length,
        paragraphCount: description.split(/\n\n+/).length,
      },
    };
    this.details.push(detail);

    logger.debug("Token/Cost analysis:", detail);

    // Add metrics for Grafana
    logger.info("METRIC:tokens_used", {
      event_type: "metric",
      metric_name: "tokens_used",
      metric_value: imageTokens + outputTokens,
      image_id: imageData.public_id,
      is_screenshot: isScreenshot,
      labels: {
        metric: "tokens_used",
        image_type: isScreenshot ? "screenshot" : "photo",
      },
    });

    logger.info("METRIC:processing_cost", {
      event_type: "metric",
      metric_name: "processing_cost",
      metric_value: totalCost,
      image_id: imageData.public_id,
      is_screenshot: isScreenshot,
    });
  }

  getReport() {
    const duration = Date.now() - this.startTime;

    // Calculate averages
    const avgTokensPerImage = this.processedImages
      ? Math.round(this.totalTokens / this.processedImages)
      : 0;
    const avgCostPerImage = this.processedImages
      ? Number((this.totalCost / this.processedImages).toFixed(4))
      : 0;

    const report = {
      summary: {
        totalTokens: this.totalTokens,
        totalCost: Number(this.totalCost.toFixed(4)),
        processedImages: this.processedImages,
        failedImages: this.failedImages,
        averageTokensPerImage: avgTokensPerImage,
        averageCostPerImage: avgCostPerImage,
        durationSeconds: Math.round(duration / 1000),
        imagesPerSecond: Number(
          (this.processedImages / (duration / 1000)).toFixed(2)
        ),
      },
      // Group costs by type
      costs: {
        images: Number(
          (this.processedImages * this.rates.input.image).toFixed(4)
        ),
        inputTokens: Number(
          ((this.totalTokens * this.rates.input.text) / 1000).toFixed(4)
        ),
        outputTokens: Number(
          ((this.totalTokens * this.rates.output) / 1000).toFixed(4)
        ),
      },
      // Include all per-image details
      details: this.details,
    };

    // Add final metrics
    logger.info("METRIC:total_cost", {
      event_type: "metric",
      metric_name: "total_cost",
      metric_value: report.summary.totalCost,
      processed_images: report.summary.processedImages,
      failed_images: report.summary.failedImages,
    });

    logger.info("METRIC:processing_speed", {
      event_type: "metric",
      metric_name: "images_per_second",
      metric_value: report.summary.imagesPerSecond,
      total_duration: report.summary.durationSeconds,
    });

    return report;
  }
}

/**
 * Fetches unprocessed images from Cloudinary
 *
 * @param {number} maxResults - Maximum number of images to fetch
 * @returns {Promise<Array>} Array of unprocessed image objects
 *
 * Debug tip: Set maxResults to 1 or 2 during testing
 */
async function getCloudinaryImages(maxResults = 100) {
  logger.debug("Fetching Cloudinary images", { maxResults });
  let allImages = [];
  let nextCursor = null;

  try {
    do {
      const result = await new Promise((resolve, reject) => {
        cloudinary.api.resources(
          {
            type: "upload",
            max_results: Math.min(500, maxResults - allImages.length), // Cloudinary max per request
            next_cursor: nextCursor,
            tags: true,
            context: true,
          },
          (error, result) => {
            if (error) {
              logger.error("Cloudinary API error:", error);
              reject(error);
            } else {
              resolve(result);
            }
          }
        );
      });

      // Add debug logging
      logger.debug("Cloudinary page response:", {
        pageSize: result.resources.length,
        hasMore: !!result.next_cursor,
        cursor: result.next_cursor,
      });

      // Filter and add images from this page
      const pageImages = result.resources
        .filter((res) => {
          // Skip anything in the automated screenshots folder
          if (res.public_id.includes("scrapbook/screenshots")) {
            logger.debug("Skipping automated screenshot:", res.public_id);
            return false;
          }

          // Process if it's unprocessed or reprocess flag is set
          return (
            argv.reprocess || !res.tags || !res.tags.includes("ai_processed")
          );
        })
        .map((resource) => ({
          ...resource,
          url: resource.secure_url,
        }));

      allImages = allImages.concat(pageImages);
      nextCursor = result.next_cursor;

      // Break if we've hit maxResults
      if (allImages.length >= maxResults) {
        allImages = allImages.slice(0, maxResults);
        break;
      }
    } while (nextCursor && allImages.length < maxResults);

    logger.info("Cloudinary fetch complete", {
      totalImages: allImages.length,
      unprocessedCount: allImages.length,
      processedCount: 0,
      skippedAutomated: allImages.filter((r) =>
        r.public_id.includes("scrapbook/screenshots")
      ).length,
    });

    return allImages;
  } catch (error) {
    logger.error("Error fetching Cloudinary resources:", error);
    return [];
  }
}

// Update the prompt to be defined as a constant
const ANALYSIS_PROMPT = `
Analyze this image concisely. If it's a screenshot, focus on UI/functionality and EXACT text. If it's a photograph, focus on subject/composition.

1. Type & Context:
   - For Screenshots: App name, page name, exact navigation path if visible
   - For Photos: Subject, setting, time of day, composition

2. Key Text & Content (use "quotes" for exact text):
   - Screenshots: ALL visible text in UI - buttons, labels, messages, data
   - Photos: Any visible text, signs, or labels
   - Include ALL numbers, metrics, and data points exactly as shown
   - Capture complete error messages or system states

3. Interface & Technical Details:
   - Screenshots: Navigation structure, interactive elements, system state
   - Photos: Camera settings, techniques, notable effects
   - Quote ALL menu items, button labels, and status messages

4. Notable Elements:
   - Screenshots: Data structures, code snippets, exact variable names
   - Photos: Interesting details, patterns, unique aspects
   - Include ALL version numbers, IDs, or technical parameters

Be thorough with text capture but concise in description. Use "quotes" for ALL exact text from screenshots. Organize in 2-3 clear paragraphs.
`;

/**
 * Analyzes an image using Gemini Vision API
 */
async function analyzeImageWithGemini(imageUrl) {
  logger.debug("Starting Gemini analysis", { imageUrl });

  try {
    // Fetch the image
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(
        `Failed to access image URL: ${imageResponse.status} - ${imageUrl}`
      );
    }

    // Get the image data as ArrayBuffer instead of Buffer
    const imageData = await imageResponse.arrayBuffer();
    const base64Data = Buffer.from(imageData).toString("base64");

    // Initialize the model with Gemini-1.5-Flash-8B
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-8b",
      generationConfig: {
        temperature: 0.4,
        topK: 32,
        topP: 1,
        maxOutputTokens: 2048,
      },
    });

    // Prepare the image part
    const imagePart = {
      inlineData: {
        data: base64Data,
        mimeType: "image/png",
      },
    };

    // Generate content with proper error handling
    const result = await model.generateContent([ANALYSIS_PROMPT, imagePart]);
    const geminiResponse = await result.response;
    const responseText = geminiResponse.text();

    if (!responseText) {
      throw new Error("Empty response from Gemini API");
    }

    const wordCount = responseText.split(/\s+/).length;
    logger.debug("Gemini response stats", {
      preview: responseText.slice(0, 100) + "...",
      wordCount,
      characterCount: responseText.length,
      paragraphCount: responseText.split(/\n\n+/).length,
    });

    return responseText;
  } catch (error) {
    const errorMessage = error.message || "";
    if (errorMessage.includes("quota")) {
      logger.error("API quota exceeded. Please check your Gemini API limits.");
    } else if (errorMessage.includes("permission")) {
      logger.error(
        "API key permissions issue. Verify your Gemini API key has proper access."
      );
    } else if (errorMessage.includes("invalid")) {
      logger.error(
        "Invalid API key. Please check your GOOGLE_API_KEY environment variable."
      );
    } else {
      logger.error("Error analyzing image with Gemini:", {
        error: errorMessage,
        imageUrl,
        stack: error.stack,
      });
    }
    return "";
  }
}

/**
 * Updates Cloudinary metadata with generated description
 */
async function updateCloudinaryMetadata(
  publicId,
  description,
  tracker,
  retries = 3
) {
  logger.debug("Updating Cloudinary metadata", {
    publicId,
    descriptionLength: description.length,
    retriesLeft: retries,
    isDryRun: !!argv["dry-run"],
  });

  try {
    // First update the context metadata
    const success = await new Promise((resolve, reject) => {
      cloudinary.uploader.explicit(
        publicId,
        {
          type: "upload",
          context: {
            ai_description: description,
            updated_at: new Date().toISOString(),
          },
          tags: ["ai_processed"],
        },
        (error, result) => {
          if (error) {
            const errorMessage = error.message || "";
            if (errorMessage.includes("Rate Limited")) {
              logger.error(
                "Cloudinary rate limit reached. Try reducing batch size with --n flag."
              );
            } else if (errorMessage.includes("authentication")) {
              logger.error(
                "Cloudinary authentication failed. Check your API credentials."
              );
            } else {
              logger.error("Error updating Cloudinary metadata:", {
                error,
                publicId,
              });
            }
            reject(error);
          } else {
            const tokenEstimate = Math.ceil(description.length / 4);
            tracker.addUsage({ public_id: publicId }, description, true);
            logger.debug("Metadata update successful", {
              publicId,
              tokenEstimate,
              contextLength: result?.context?.ai_description?.length,
              tags: result?.tags,
            });
            resolve(true);
          }
        }
      );
    });

    // Add verification after successful update
    if (success && !argv["dry-run"]) {
      // Verify the update
      const verificationResult = await verifyCloudinaryUpdate(publicId);
      if (!verificationResult?.context?.custom?.ai_description) {
        logger.warn("Update verification failed - description not found", {
          publicId,
        });
        return false;
      }
      logger.info("Update verified successfully", {
        publicId,
        descriptionLength:
          verificationResult.context.custom.ai_description.length,
        tags: verificationResult.tags,
      });
    }

    return success;
  } catch (error) {
    if (retries > 0 && error.message.includes("Rate Limited")) {
      logger.warn(`Rate limited, retrying in 5s... (${retries} retries left)`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return updateCloudinaryMetadata(
        publicId,
        description,
        tracker,
        retries - 1
      );
    }
    const errorMessage = error.message || "";
    if (errorMessage.includes("Rate Limited")) {
      logger.error(
        "Cloudinary rate limit reached. Try reducing batch size with --n flag."
      );
    } else if (errorMessage.includes("authentication")) {
      logger.error(
        "Cloudinary authentication failed. Check your API credentials."
      );
    } else {
      logger.error("Error updating Cloudinary metadata:", {
        error,
        publicId,
      });
    }
    return false;
  }
}

/**
 * Creates directory if it doesn't exist
 *
 * @param {string} dirPath - Directory path to create
 */
async function ensureDirectoryExists(dirPath) {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
    logger.debug("Created directory:", dirPath);
  }
}

/**
 * Main execution function
 *
 * Debug tips:
 * - Set process.env.LOG_LEVEL = 'debug' for verbose logging
 * - Use small maxResults values during testing
 * - Check logs/debug.log for detailed execution flow
 */
async function main() {
  globalTracker = new TokenUsageTracker();

  try {
    await ensureDirectoryExists("logs");
    await ensureDirectoryExists("reports");

    const images = await getCloudinaryImages(
      process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE) : 100
    );

    logger.info(`Found ${images.length} unprocessed images`);

    // Process images in batches
    await processBatch(images, globalTracker);

    // Generate report
    const report = globalTracker.getReport();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join("reports", `usage_report_${timestamp}.json`);

    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

    logger.info("Processing complete", {
      reportPath,
      ...report,
    });

    await gracefulShutdown(logger);
  } catch (error) {
    logger.error("Error in main process:", error);
    await gracefulShutdown(logger);
    throw error;
  }
}

/**
 * CLI Argument Parser
 * Handles command line flags for controlling script execution
 *
 * Available flags:
 * --n=NUMBER         Process specific number of images
 * --dry-run         Run without making API updates
 * --verbose         Enable detailed logging
 * --analyze=ID      Analyze specific Cloudinary public ID
 * --report          Just show latest processing report
 * --clear-logs      Clear log files before running
 * --health-check    Run system health check
 * --verify-config   Verify system configuration
 * --reprocess       Force reprocessing of images
 */
const argv = minimist(process.argv.slice(2), {
  string: ["n", "analyze"],
  boolean: [
    "dry-run",
    "verbose",
    "report",
    "clear-logs",
    "health-check",
    "verify-config",
    "reprocess",
  ],
  alias: {
    n: "number",
    d: "dry-run",
    v: "verbose",
    a: "analyze",
    r: "report",
    c: "clear-logs",
    h: "health-check",
    f: "reprocess",
  },
});

/**
 * Displays latest processing report
 */
async function showLatestReport() {
  try {
    const reports = await fs.readdir("reports");
    if (reports.length === 0) {
      console.log("No reports found");
      return;
    }

    const latestReport = reports
      .filter((f) => f.startsWith("usage_report_"))
      .sort()
      .pop();

    if (latestReport) {
      const report = JSON.parse(
        await fs.readFile(path.join("reports", latestReport), "utf8")
      );
      console.table(report);
    }
  } catch (error) {
    logger.error("Error reading report:", error);
  }
}

/**
 * Clears log files
 */
async function clearLogs() {
  const logFiles = ["error.log", "debug.log", "combined.log"];
  for (const file of logFiles) {
    try {
      await fs.writeFile(path.join("logs", file), "");
      logger.info(`Cleared ${file}`);
    } catch (error) {
      logger.error(`Error clearing ${file}:`, error);
    }
  }
}

/**
 * Analyze single image by ID
 */
async function analyzeSingleImage(publicId) {
  try {
    const result = await new Promise((resolve, reject) => {
      cloudinary.api.resource(publicId, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });

    const tracker = new TokenUsageTracker();
    const description = await analyzeImageWithGemini(result.url);

    if (description) {
      console.log("\nAnalysis Result:");
      console.log("================");
      console.log(description);
      console.log(
        "\nToken Estimate:",
        Math.ceil(description.split(" ").length * 1.3)
      );
    }
  } catch (error) {
    logger.error("Error analyzing single image:", error);
  }
}

/**
 * Performs a health check of all system components
 */
async function healthCheck() {
  logger.info("Running system health check...");
  const checks = {
    cloudinary: false,
    gemini: false,
    filesystem: false,
  };

  try {
    // Test Cloudinary connection
    await promisify(cloudinary.api.ping)();
    checks.cloudinary = true;

    // Test Gemini API with updated model name
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });
    await model.generateContent(["Test"]);
    checks.gemini = true;

    // Test filesystem access
    await ensureDirectoryExists("logs");
    await ensureDirectoryExists("reports");
    checks.filesystem = true;

    console.table(checks);
    return Object.values(checks).every(Boolean);
  } catch (error) {
    logger.error("Health check failed:", error);
    console.table(checks);
    return false;
  }
}

/**
 * Verifies all required configuration is present and valid
 */
async function verifyConfig() {
  logger.info("Verifying configuration...");

  const config = {
    CLOUDINARY_CLOUD_NAME: !!process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: !!process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: !!process.env.CLOUDINARY_API_SECRET,
    GOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
    "logs directory": await fs
      .access("logs")
      .then(() => true)
      .catch(() => false),
    "reports directory": await fs
      .access("reports")
      .then(() => true)
      .catch(() => false),
  };

  console.table(config);
  return Object.values(config).every(Boolean);
}

// Process CLI flags and run appropriate mode
async function run() {
  // Set logging level based on verbose flag
  if (argv.verbose) {
    logger.level = "debug";
  }

  // Handle export FIRST
  if (argv.export) {
    logger.info("Starting export", {
      fromDate: argv["export-from"],
      toDate: argv["export-to"],
    });
    const exportPath = await exportImageData(
      argv["export-from"],
      argv["export-to"]
    );
    logger.info("Export complete", { path: exportPath });
    return; // Important: return here to prevent main processing
  }

  // Handle health check
  if (argv["health-check"]) {
    const healthy = await healthCheck();
    process.exit(healthy ? 0 : 1);
    return;
  }

  // Handle config verification
  if (argv["verify-config"]) {
    const valid = await verifyConfig();
    process.exit(valid ? 0 : 1);
    return;
  }

  // Clear logs if requested
  if (argv["clear-logs"]) {
    await clearLogs();
  }

  // Show latest report if requested
  if (argv.report) {
    await showLatestReport();
    return;
  }

  // Analyze single image if ID provided
  if (argv.analyze) {
    await analyzeSingleImage(argv.analyze);
    return;
  }

  // Configure batch size
  if (argv.n) {
    process.env.BATCH_SIZE = argv.n;
  }

  // Set dry run mode
  if (argv["dry-run"]) {
    logger.info("Running in dry-run mode - no updates will be made");
    updateCloudinaryMetadata = async (publicId, description, tracker) => {
      const wordCount = description.split(/\s+/).length;
      logger.info("DRY RUN - Would update:", {
        publicId,
        descriptionPreview: description.slice(0, 100),
        wordCount,
        characterCount: description.length,
        paragraphCount: description.split(/\n\n+/).length,
      });
      tracker.addUsage(Math.ceil(description.split(" ").length * 1.3));
      return true;
    };
  }

  logger.info("Starting screenshot analysis script", {
    batchSize: process.env.BATCH_SIZE || "unlimited",
    dryRun: argv["dry-run"] || false,
    verbose: argv.verbose || false,
  });

  await main();
}

// Run the script with error handling
run().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});

// Add batch processing with delay
async function processBatch(images, tracker) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Process in chunks to respect rate limits
  const chunks = [];
  for (let i = 0; i < images.length; i += RATE_LIMITS.REQUESTS_PER_MINUTE) {
    chunks.push(images.slice(i, i + RATE_LIMITS.REQUESTS_PER_MINUTE));
  }

  for (const chunk of chunks) {
    logger.info(`Processing chunk of ${chunk.length} images...`);

    for (const image of chunk) {
      logger.debug("Processing image", { publicId: image.public_id });

      try {
        const description = await analyzeImageWithGemini(image.url);

        if (description) {
          const success = await updateCloudinaryMetadata(
            image.public_id,
            description,
            tracker
          );

          if (success) {
            logger.info(`Successfully processed ${image.public_id}`);
          } else {
            logger.error(`Failed to update metadata for ${image.public_id}`);
            tracker.addUsage(0, false);
          }
        }

        // Add delay between requests
        await delay(RATE_LIMITS.DELAY_BETWEEN_REQUESTS);
      } catch (error) {
        logger.error(`Failed to process image ${image.public_id}:`, error);
        tracker.addUsage(0, false);
      }
    }

    // Add a small pause between chunks
    await delay(1000);
  }
}

// Add graceful shutdown handling
process.on("SIGINT", async () => {
  console.log("Received SIGINT");
  await gracefulShutdown(logger);
});

process.on("SIGTERM", async () => {
  console.log("Received SIGTERM");
  await gracefulShutdown(logger);
});

// Add this function
async function verifyCloudinaryUpdate(publicId) {
  try {
    const result = await new Promise((resolve, reject) => {
      cloudinary.api.resource(
        publicId,
        { context: true, tags: true },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
    });

    const verificationDetails = {
      publicId,
      hasDescription: !!result.context?.custom?.ai_description,
      descriptionLength: result.context?.custom?.ai_description?.length || 0,
      tags: result.tags || [],
      processed: result.tags?.includes("ai_processed"),
      contextKeys: Object.keys(result.context || {}),
    };

    logger.info("Verification result:", verificationDetails);

    return result;
  } catch (error) {
    logger.error("Verification failed:", {
      error: error.message,
      publicId,
      stack: error.stack,
    });
    return null;
  }
}

// Add near the top with other constants
const RATE_LIMITS = {
  REQUESTS_PER_MINUTE: 240, // Well under the 4,000 RPM limit
  DELAY_BETWEEN_REQUESTS: 250, // ms, 4 requests per second
};

async function exportImageData(fromDate, toDate) {
  let allImages = [];
  let nextCursor = null;

  try {
    do {
      const result = await new Promise((resolve, reject) => {
        cloudinary.api.resources(
          {
            type: "upload",
            max_results: 500,
            next_cursor: nextCursor,
            tags: true,
            context: true,
            prefix: "", // Get all folders
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
      });

      // Filter and transform images
      const pageImages = result.resources
        .filter((res) => {
          // Skip automated screenshots
          if (res.public_id.includes("scrapbook/screenshots")) return false;

          // Only get processed images
          if (!res.tags?.includes("ai_processed")) return false;

          // Apply date filter if provided
          if (fromDate || toDate) {
            const createdAt = new Date(res.created_at);
            if (fromDate && createdAt < new Date(fromDate)) return false;
            if (toDate && createdAt > new Date(toDate)) return false;
          }

          return true;
        })
        .map((resource) => ({
          id: resource.public_id,
          url: resource.secure_url,
          created_at: resource.created_at,
          analysis: resource.context?.custom?.ai_description,
          analyzed_at: resource.context?.custom?.updated_at,
          width: resource.width,
          height: resource.height,
          format: resource.format,
          bytes: resource.bytes,
          tags: resource.tags || [],
        }));

      allImages = allImages.concat(pageImages);
      nextCursor = result.next_cursor;
    } while (nextCursor);

    // Generate export file
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const exportPath = path.join("exports", `image_export_${timestamp}.json`);

    await ensureDirectoryExists("exports");

    const exportData = {
      generated_at: new Date().toISOString(),
      filters: {
        from_date: fromDate || null,
        to_date: toDate || null,
      },
      stats: {
        total_images: allImages.length,
        date_range: {
          earliest: allImages[allImages.length - 1]?.created_at,
          latest: allImages[0]?.created_at,
        },
      },
      images: allImages,
    };

    await fs.writeFile(exportPath, JSON.stringify(exportData, null, 2));

    return exportPath;
  } catch (error) {
    logger.error("Export failed:", error);
    throw error;
  }
}

// Add this function
async function gracefulShutdown(logger) {
  console.log("Starting graceful shutdown...");

  try {
    // Get all transports that need closing
    const lokiTransports = logger.transports.filter(
      (t) => t instanceof LokiTransport
    );

    // Close each Loki transport
    for (const transport of lokiTransports) {
      console.log("Closing Loki transport...");
      if (transport.close) {
        await promisify(transport.close.bind(transport))();
      }
    }

    console.log("All transports closed");

    // Small delay to ensure last logs are sent
    await new Promise((resolve) => setTimeout(resolve, 1000));

    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

// Start Express server
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  logger.info(`Health check server listening on port ${PORT}`);
});
