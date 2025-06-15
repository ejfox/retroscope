/**
 * Content Creation Pipeline
 *
 * This module handles the automated content creation workflow using Cloudinary assets
 * and n8n integration. It includes:
 * - Intelligent content discovery based on AI descriptions
 * - Content ideation for visually interesting images
 * - Approval tracking
 * - Asset generation for social media
 */

import { v2 as cloudinary } from "cloudinary";
import { GoogleGenerativeAI } from "@google/generative-ai";
import winston from "winston";
import fetch from "node-fetch";
import dotenv from "dotenv";
import Bottleneck from "bottleneck";
import fs from "fs/promises";

// Load environment variables
dotenv.config();

// Initialize Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Create a rate limiter for Cloudinary API
// Cloudinary's base tier limits to 500 operations/hour (about 8.3 ops/min)
// We'll be conservative with 6 requests per minute (1 every 10 seconds)
const cloudinaryLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1000, // 1 request per second
  reservoir: 100, // Start with 100 tokens
  reservoirRefreshAmount: 100, // Refill 100 tokens
  reservoirRefreshInterval: 60 * 60 * 1000, // every hour in milliseconds
});

// Apply exponential backoff on failures
cloudinaryLimiter.on("failed", (error, jobInfo) => {
  if (error.message && error.message.includes("Rate Limit Exceeded")) {
    // Only retry up to 3 times
    if (jobInfo.retryCount < 3) {
      // Exponential backoff: 2s, 4s, 8s
      const delay = Math.pow(2, jobInfo.retryCount + 1) * 1000;
      logger.warn(
        `Rate limit hit. Retrying in ${delay}ms (attempt ${
          jobInfo.retryCount + 1
        }/3)`
      );
      return delay;
    }
  }
  // Don't retry other errors or after max retries
  return null;
});

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Discord webhook URL for n8n integration (configurable via env var)
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "https://n8n.tools.ejfox.com/webhook/new-jep-ques";

// Create a logger instance
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: "content-pipeline" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({ filename: "logs/content-pipeline.log" }),
  ],
});

// Wrap Cloudinary API calls with the limiter
const getCloudinaryResources = cloudinaryLimiter.wrap((options) => {
  return new Promise((resolve, reject) => {
    cloudinary.api.resources(options, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
});

// Wrap Cloudinary uploader methods with rate limiting
const cloudinaryUpdate = cloudinaryLimiter.wrap((publicId, options) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.explicit(publicId, options, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
});

// Wrap Cloudinary API resource retrieval with rate limiting
const getCloudinaryResource = cloudinaryLimiter.wrap((publicId, options) => {
  return new Promise((resolve, reject) => {
    cloudinary.api.resource(publicId, options, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
});

// Wrap Cloudinary uploader with rate limiting
const cloudinaryUpload = cloudinaryLimiter.wrap((url, options) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(url, options, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
});

/**
 * Fetches images from Cloudinary that have AI descriptions
 * @param {number} maxResults - Maximum number of images to analyze
 * @param {number} daysBack - Only fetch images from the last N days (default: 7)
 * @returns {Promise<Array>} Array of image objects with AI descriptions
 */
async function getImagesWithDescriptions(maxResults = 100, daysBack = 7) {
  logger.info(
    `Fetching up to ${maxResults} images with AI descriptions from the past ${daysBack} days`
  );
  let allImages = [];
  let nextCursor = null;

  // Calculate the date threshold
  const dateThreshold = new Date();
  dateThreshold.setDate(dateThreshold.getDate() - daysBack);

  try {
    do {
      // Get a batch of images with rate limiting
      const options = {
        type: "upload",
        max_results: Math.min(500, maxResults - allImages.length),
        next_cursor: nextCursor,
        context: true,
        sort_by: "created_at",
        direction: "desc",
      };

      try {
        const result = await getCloudinaryResources(options);

        // Log what we found
        logger.info(`Found ${result.resources.length} images in this batch`, {
          hasNextPage: !!result.next_cursor,
          firstImageId: result.resources[0]?.public_id,
          firstImageTags: result.resources[0]?.tags,
          firstImageContext: result.resources[0]?.context,
        });

        // Filter and transform images
        const pageImages = result.resources
          .filter((res) => {
            // Add debug logging for each filter condition
            logger.debug(`Filtering image ${res.public_id}:`, {
              hasAiDescription: !!res.context?.custom?.ai_description,
              tags: res.tags || [],
              isContentProcessed: res.tags?.includes("content_processed"),
              isClient: res.tags?.includes("client"),
              isPrivate: res.tags?.includes("private"),
              createdAt: res.created_at,
              isWithinDateRange: new Date(res.created_at) >= dateThreshold,
            });

            // Skip if already used for content creation
            if (res.tags?.includes("content_processed")) {
              logger.debug(
                `Skipping ${res.public_id}: already processed for content`
              );
              return false;
            }

            // Skip client/private work
            if (res.tags?.includes("client") || res.tags?.includes("private")) {
              logger.debug(`Skipping ${res.public_id}: client or private work`);
              return false;
            }

            // Skip if no AI description
            if (!res.context?.custom?.ai_description) {
              logger.debug(`Skipping ${res.public_id}: no AI description`);
              return false;
            }

            // Skip if older than threshold date
            const createdAt = new Date(res.created_at);
            if (createdAt < dateThreshold) {
              logger.debug(
                `Skipping ${res.public_id}: too old (${createdAt} < ${dateThreshold})`
              );
              return false;
            }

            logger.debug(`Including ${res.public_id} in results`);
            return true;
          })
          .map((resource) => ({
            id: resource.public_id,
            url: resource.secure_url,
            created_at: resource.created_at,
            width: resource.width,
            height: resource.height,
            description: resource.context?.custom?.ai_description || "",
            format: resource.format,
            tags: resource.tags || [],
            // Extract cached content data if available
            cached_score: parseCachedValue(
              resource.context?.custom?.content_score
            ),
            cached_reason: resource.context?.custom?.content_reason || "",
            cached_audience: resource.context?.custom?.content_audience || "",
            cached_platform: resource.context?.custom?.content_platform || "",
            cached_pitches: parseCachedPitches(
              resource.context?.custom?.content_pitches
            ),
          }));

        allImages = allImages.concat(pageImages);
        nextCursor = result.next_cursor;

        // Break if we've hit maxResults
        if (allImages.length >= maxResults) {
          allImages = allImages.slice(0, maxResults);
          break;
        }

        // Break if we've reached the date threshold (all further images will be older)
        if (pageImages.length > 0) {
          const oldestInBatch = new Date(
            pageImages[pageImages.length - 1].created_at
          );
          if (oldestInBatch < dateThreshold) {
            logger.info("Reached date threshold, stopping pagination");
            break;
          }
        }
      } catch (error) {
        logger.error("Error fetching Cloudinary resources:", error);
        // Continue to next batch if we have a cursor, otherwise exit
        if (!nextCursor) break;
      }
    } while (nextCursor && allImages.length < maxResults);

    logger.info(`Found ${allImages.length} recent images with AI descriptions`);
    return allImages;
  } catch (error) {
    logger.error("Error fetching Cloudinary resources:", error);
    return [];
  }
}

/**
 * Caches content scoring data in Cloudinary metadata
 * @param {string} publicId - Cloudinary public ID
 * @param {Object} contentData - Content data to cache
 */
async function cacheContentData(publicId, contentData) {
  try {
    // Store pitches as JSON string
    const pitchesJson = contentData.pitches
      ? JSON.stringify(contentData.pitches)
      : "";

    // Log what we're trying to cache
    logger.debug(`Caching content data for ${publicId}`, {
      score: contentData.score,
      platform: contentData.best_platform,
      pitchesCount: contentData.pitches ? contentData.pitches.length : 0,
    });

    // Add tags for identifying processed content
    const tags = [...(contentData.tags || [])];
    if (!tags.includes("content_scored")) {
      tags.push("content_scored");
    }

    // Cloudinary expects context values to be strings
    const contextData = {
      content_score: contentData.score?.toString() || "0",
      content_reason: contentData.reason || "",
      content_audience: contentData.audience || "",
      content_platform: contentData.best_platform || "",
      content_pitches: pitchesJson,
      content_updated_at: new Date().toISOString(),
    };

    // Update the metadata in Cloudinary using rate-limited function
    const result = await cloudinaryUpdate(publicId, {
      type: "upload",
      context: contextData,
      tags: tags,
    });

    // Verify the update was successful
    if (
      result &&
      result.context &&
      result.context.custom &&
      result.context.custom.content_score === contextData.content_score
    ) {
      logger.info(
        `Successfully cached content data for ${publicId} (score: ${contentData.score})`
      );
      return true;
    } else {
      logger.warn(
        `Cache verification failed for ${publicId} - data may not have been stored correctly`,
        {
          result: result ? Object.keys(result).join(",") : "null",
          context: result?.context
            ? Object.keys(result.context).join(",")
            : "null",
          custom: result?.context?.custom
            ? Object.keys(result.context.custom).join(",")
            : "null",
        }
      );
      return false;
    }
  } catch (error) {
    logger.error(`Failed to cache content data for ${publicId}:`, error);
    return false;
  }
}

/**
 * Helper to parse cached score value from string
 */
function parseCachedValue(value) {
  if (!value) return null;
  const num = parseInt(value, 10);
  return isNaN(num) ? null : num;
}

/**
 * Helper to parse cached pitches from JSON string
 */
function parseCachedPitches(pitchesJson) {
  if (!pitchesJson || pitchesJson === "") return null;
  try {
    const parsed = JSON.parse(pitchesJson);
    // Verify it's actually an array of strings
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      typeof parsed[0] === "string"
    ) {
      return parsed;
    }
    return null;
  } catch (error) {
    logger.debug(`Failed to parse cached pitches: ${error.message}`);
    return null;
  }
}

/**
 * Scores images based on their visual interest and uniqueness
 * Uses cached scores when available
 * @param {Array} images - Array of images with AI descriptions
 * @returns {Promise<Array>} Scored and sorted images
 */
async function scoreImagesForContentValue(images) {
  logger.info(`Scoring ${images.length} images for content value`);

  // Double-check for cached data and log details for debugging
  images.forEach((img) => {
    logger.debug(`Image ${img.id} cache status:`, {
      has_cached_score: img.cached_score !== null,
      cached_score: img.cached_score,
      has_cached_pitches: img.cached_pitches !== null,
      cached_pitches_count: img.cached_pitches ? img.cached_pitches.length : 0,
      tags: img.tags.join(","),
    });
  });

  // Separate images that already have cached scores
  const cachedImages = images.filter((img) => img.cached_score !== null);
  const uncachedImages = images.filter((img) => img.cached_score === null);

  logger.info(
    `Found ${cachedImages.length} cached image scores, ${uncachedImages.length} need processing`
  );

  // Process images that don't have cached scores
  const newlyScoredImages = [];

  if (uncachedImages.length > 0) {
    // Create a Gemini model instance for scoring
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });

    // Process images in batches to avoid rate limits
    const batchSize = 5; // Reduce batch size for testing

    for (let i = 0; i < uncachedImages.length; i += batchSize) {
      const batch = uncachedImages.slice(i, i + batchSize);
      logger.info(
        `Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(
          uncachedImages.length / batchSize
        )} (${batch.length} images)`
      );

      const scoredBatch = await Promise.all(
        batch.map(async (image) => {
          try {
            const prompt = `
              Evaluate this image description for content marketing potential.
              
              ${image.description}
              
              Score this image from 0-100 on these criteria and calculate a total score:
              1. Visual uniqueness and memorability (0-25 points)
                 - High scores for unusual, striking, or emotionally evocative imagery
                 - Low scores for common, generic screenshots or mundane photos
              
              2. Storytelling potential (0-25 points)
                 - High scores for images that suggest a narrative or journey
                 - Low scores for isolated UI elements with no context
              
              3. Audience engagement likelihood (0-25 points)
                 - High scores for content that would generate comments/shares
                 - Low scores for overly technical content only specialists would understand
              
              4. Brand alignment & social shareability (0-25 points)
                 - High scores for content that represents creative/tech innovation
                 - Low scores for purely utilitarian or contextless images
              
              Respond ONLY with a JSON object like this:
              {
                "total_score": 85,
                "reason": "Brief, specific explanation of why this would make good content - be descriptive and specific about what makes this visually interesting",
                "audience": "Specific description of who would engage with this content",
                "best_platform": "Specific platform name(s) this content would perform best on"
              }
            `;

            const result = await model.generateContent(prompt);
            const text = result.response.text();

            // Extract and safely parse the JSON response
            let scoreData = { total_score: 0 };
            try {
              // Try to extract JSON from the text
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                // Clean the JSON string before parsing
                const jsonStr = jsonMatch[0]
                  .replace(/\\([^"bfnrtu\\])/g, "$1") // Fix invalid escape sequences
                  .replace(/[\u0000-\u001F]+/g, " "); // Remove control characters

                scoreData = JSON.parse(jsonStr);
                logger.debug(`Successfully parsed JSON for image ${image.id}`);
              } else {
                // Fallback to manual extraction if no JSON found
                const scoreMatch = text.match(/total_score"?\s*:\s*(\d+)/);
                const reasonMatch = text.match(/reason"?\s*:\s*"([^"]+)"/);
                const audienceMatch = text.match(/audience"?\s*:\s*"([^"]+)"/);
                const platformMatch = text.match(
                  /best_platform"?\s*:\s*"([^"]+)"/
                );

                scoreData = {
                  total_score: scoreMatch ? parseInt(scoreMatch[1]) : 50,
                  reason: reasonMatch
                    ? reasonMatch[1]
                    : "Potentially interesting visual content",
                  audience: audienceMatch
                    ? audienceMatch[1]
                    : "General audience",
                  best_platform: platformMatch ? platformMatch[1] : "instagram",
                };

                logger.debug(`Manually extracted data for image ${image.id}`);
              }
            } catch (parseError) {
              logger.warn(
                `JSON parse error for image ${image.id}: ${parseError.message}. Using default values.`
              );
              // Use default values if parsing fails
              scoreData = {
                total_score: 50,
                reason: "Potential visual content (parsing error)",
                audience: "General audience",
                best_platform: "instagram",
              };
            }

            const scoredImage = {
              ...image,
              score: scoreData.total_score || 0,
              reason: scoreData.reason || "",
              audience: scoreData.audience || "",
              best_platform: scoreData.best_platform || "instagram",
            };

            // Cache the score and content data in Cloudinary
            await cacheContentData(image.id, scoredImage);

            return scoredImage;
          } catch (error) {
            logger.error(`Error scoring image ${image.id}:`, error);
            return {
              ...image,
              score: 0,
              reason: "Error during evaluation",
              audience: "Unknown",
              best_platform: "instagram",
            };
          }
        })
      );

      newlyScoredImages.push(...scoredBatch);

      // Add a small delay between batches to avoid rate limiting
      if (i + batchSize < uncachedImages.length) {
        logger.debug("Waiting between batches to avoid API rate limits...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  // Convert cached images to the same format as newly scored images
  const formattedCachedImages = cachedImages.map((img) => {
    logger.debug(
      `Using cached data for ${img.id} - score: ${
        img.cached_score
      }, has pitches: ${img.cached_pitches !== null}`
    );
    return {
      ...img,
      score: img.cached_score,
      reason: img.cached_reason,
      audience: img.cached_audience,
      best_platform: img.cached_platform,
      pitches: img.cached_pitches || [],
      cached: true,
    };
  });

  // Combine cached and newly scored images
  const allScoredImages = [...formattedCachedImages, ...newlyScoredImages];

  // Sort by score (highest first)
  const sortedImages = allScoredImages.sort((a, b) => b.score - a.score);

  logger.info(
    `Processed ${allScoredImages.length} images, top score: ${
      sortedImages[0]?.score || 0
    }`
  );
  logger.info(
    `Used ${formattedCachedImages.length} cached scores, generated ${newlyScoredImages.length} new scores`
  );

  return sortedImages;
}

/**
 * Selects the top N images based on scoring
 * @param {Array} scoredImages - Array of scored images
 * @param {number} count - Number of top images to select
 * @returns {Array} Top selected images
 */
function selectTopImages(scoredImages, count = 5) {
  // Take top N images but ensure diversity by enforcing minimum score threshold
  const minScoreThreshold = 65;
  const highScoringImages = scoredImages.filter(
    (image) => image.score >= minScoreThreshold
  );

  // If we have enough high-scoring images, return the top ones
  if (highScoringImages.length >= count) {
    return highScoringImages.slice(0, count);
  }

  // Otherwise, include some lower-scoring ones to meet the count
  return scoredImages.slice(0, count);
}

/**
 * Generates content pitches based on image analysis and score
 * Uses cached pitches when available
 * @param {Object} image - Image object with score and description
 * @returns {Promise<Array<string>>} Array of content pitch ideas
 */
async function generateContentPitches(image) {
  // Check if we already have cached pitches
  if (
    image.cached_pitches &&
    Array.isArray(image.cached_pitches) &&
    image.cached_pitches.length > 0
  ) {
    logger.info(
      `Using ${image.cached_pitches.length} cached pitches for ${image.id}`
    );
    return image.cached_pitches;
  }

  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });

  const prompt = `
  You are EJ Fox's pitch-bot—part hacker, part hype-machine.
  
  BRAND + VOICE
  • Nature-punk hacker-journalist energy: playful, cinematic, a touch rebellious  
  • Values: open-source, creative tech, data-storytelling, outdoor adventure
  
  AUDIENCE
  Indie devs, data-viz hackers, creative technologists, and outdoor-loving makers.
  
  TASK
  Using the image metadata below, craft **3-5** scroll-stopping content pitches.
  
  Image ➜ ${image.description}
  Why it matters ➜ ${image.reason}
  Who will love it ➜ ${image.audience}
  Best platform ➜ ${image.best_platform || "social"}
  
  GUIDELINES
  1. Each pitch = 1–2 sentences, starts with **PITCH:**  
  2. Highlight a unique hook or benefit—no generic fluff  
  3. Use real tool names when obvious (e.g., "n8n", "Supabase"); otherwise use vivid descriptors ("our zero-code automation stack")  
  4. Keep it human, hype, and shareable—skip buzzword salad
  5. Be minimal. Succinct. Well-spoken. Thoughtful. NOT cliche. No bullshit.
  6. Write personally, not like a robot or a PR spokesperson. You are a human being. 
  7. Be critical. Realisitc. Not fluffy. Don't put lipstick on a pig. 
  
  OUTPUT  
  Only the pitches, each on its own line.`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Extract pitches from response
    const pitches = text
      .split("\n")
      .filter((line) => line.startsWith("PITCH: "))
      .map((line) => line.replace("PITCH: ", "").trim());

    // Cache the pitches for future use
    if (pitches.length > 0) {
      // Update the image object with the pitches
      const updatedImage = { ...image, pitches };

      // Cache in Cloudinary
      await cacheContentData(image.id, updatedImage);
    }

    return pitches;
  } catch (error) {
    logger.error(`Error generating content pitches for ${image.id}:`, error);
    return [];
  }
}

/**
 * Sends content pitch data to Discord via webhook
 * @param {Array} images - Array of images with their pitches and scores
 */
async function sendContentToDiscord(images) {
  try {
    // Check if webhook is configured
    if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL === "https://n8n.tools.ejfox.com/webhook/new-jep-ques") {
      console.log("📢 Discord webhook not configured - skipping webhook notification");
      console.log("💡 Set DISCORD_WEBHOOK_URL in your .env file to enable Discord notifications");
      return true; // Return success so pipeline continues
    }

    const topImage = images[0];
    const imageUrl =
      topImage.url ||
      `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/${topImage.id}`;

    // Build a simple message object with just the .message property
    const messageObj = {
      message: `Found ${images.length} high-potential content opportunities. Top score: ${topImage.score}/100.\n\nTop image: ${imageUrl}`,
    };

    // Build query parameters for the GET request
    const params = new URLSearchParams();
    params.append("content", JSON.stringify(messageObj));

    // Build the webhook URL with query parameters
    const webhookUrl = `${DISCORD_WEBHOOK_URL}?${params.toString()}`;

    // Print console-friendly version
    console.log("\n=== CONTENT OPPORTUNITIES REPORT ===");
    console.log(
      `Found ${images.length} high-potential content opportunities\n`
    );

    images.forEach((image, index) => {
      console.log(`\n--- CONTENT OPPORTUNITY #${index + 1} ---`);
      console.log(`Image ID: ${image.id}`);
      console.log(`Score: ${image.score}/100`);
      console.log(`Best platform: ${image.best_platform || "Instagram"}`);
      console.log(
        `Why this works: ${image.reason || "Visually engaging content"}`
      );
      console.log(
        `Target audience: ${
          image.audience || "Tech and creative professionals"
        }`
      );
      console.log("\nContent Pitches:");
      image.pitches.forEach((pitch, i) => {
        console.log(`${i + 1}. ${pitch}`);
      });
      console.log(
        `\nImage URL: ${
          image.url ||
          `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/${image.id}`
        }`
      );
      console.log("----------------------------------------\n");
    });

    // Send the webhook as a GET request
    console.log(`Sending webhook to: ${DISCORD_WEBHOOK_URL.split("?")[0]}`);
    console.log(`Webhook params: ${params.toString().substring(0, 100)}...`);

    const response = await fetch(webhookUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (response.ok) {
      const responseText = await response.text();
      logger.info(
        `Content opportunities sent to Discord successfully: ${responseText.substring(
          0,
          100
        )}`
      );
      return true;
    } else {
      const errorText = await response.text();
      logger.error(
        `Error sending to Discord: ${response.status} - ${errorText}`
      );
      return false;
    }
  } catch (error) {
    logger.error("Error sending content to Discord:", error);
    return false;
  }
}

/**
 * Processes approved images and generates final assets
 * @param {string} publicId - Cloudinary public ID of the image
 * @param {string} pitch - The approved content pitch
 */
async function generateFinalAssets(publicId, pitch) {
  try {
    // Get image details to determine best format
    const imageDetails = await getCloudinaryResource(publicId, {
      context: true,
      tags: true,
    });

    // Determine if image is landscape, portrait, or square
    const aspectRatio = imageDetails.width / imageDetails.height;
    const orientation =
      aspectRatio > 1.2
        ? "landscape"
        : aspectRatio < 0.8
        ? "portrait"
        : "square";

    // Generate variations based on image orientation and platform best practices
    const variations = {
      instagram: getInstagramConfig(orientation, pitch),
      twitter: getTwitterConfig(orientation, pitch),
      linkedin: getLinkedinConfig(orientation, pitch),
    };

    // Generate and store each variation
    const results = [];
    for (const [platform, options] of Object.entries(variations)) {
      const url = cloudinary.url(publicId, {
        ...options.transformation,
        format: "jpg",
        quality: "auto",
      });

      // Store the generated asset with rate limiting
      const uploadResult = await cloudinaryUpload(url, {
        public_id: `${publicId}_${platform}`,
        tags: ["content_processed", platform],
        context: {
          original_id: publicId,
          platform,
          pitch,
        },
      });

      results.push({
        platform,
        url: uploadResult.secure_url,
        publicId: uploadResult.public_id,
      });
    }

    // Mark original image as processed
    await cloudinaryUpdate(publicId, {
      type: "upload",
      tags: ["content_processed"],
    });

    logger.info(`Generated final assets for ${publicId}`);
    return results;
  } catch (error) {
    logger.error(`Error generating final assets for ${publicId}:`, error);
    return [];
  }
}

/**
 * Get Instagram-specific configuration based on image orientation
 */
function getInstagramConfig(orientation, text) {
  const baseConfig = {
    color: "#ffffff",
    font_family: "Montserrat",
    font_weight: "bold",
  };

  switch (orientation) {
    case "landscape":
      return {
        transformation: {
          width: 1080,
          height: 608,
          crop: "fill",
          gravity: "auto",
          overlay: {
            ...baseConfig,
            font_size: 45,
            text: formatTextForOverlay(text, 40),
            x: 20,
            y: 20,
            gravity: "south_west",
            background: "rgb:000000A0",
            padding: 20,
          },
        },
      };
    case "portrait":
      return {
        transformation: {
          width: 1080,
          height: 1350,
          crop: "fill",
          gravity: "auto",
          overlay: {
            ...baseConfig,
            font_size: 50,
            text: formatTextForOverlay(text, 35),
            gravity: "south",
            y: 30,
            background: "rgb:000000A0",
            padding: 20,
          },
        },
      };
    default: // square
      return {
        transformation: {
          width: 1080,
          height: 1080,
          crop: "fill",
          gravity: "auto",
          overlay: {
            ...baseConfig,
            font_size: 50,
            text: formatTextForOverlay(text, 35),
            gravity: "south",
            y: 30,
            background: "rgb:000000A0",
            padding: 20,
          },
        },
      };
  }
}

/**
 * Get Twitter-specific configuration
 */
function getTwitterConfig(orientation, text) {
  return {
    transformation: {
      width: 1200,
      height: orientation === "portrait" ? 1350 : 675,
      crop: "fill",
      gravity: "auto",
      overlay: {
        color: "#ffffff",
        font_family: "Roboto",
        font_size: 40,
        font_weight: "bold",
        text: formatTextForOverlay(text, 48),
        gravity: "south",
        y: 30,
        background: "rgb:000000A0",
        padding: 15,
      },
    },
  };
}

/**
 * Get LinkedIn-specific configuration
 */
function getLinkedinConfig(orientation, text) {
  return {
    transformation: {
      width: 1200,
      height: orientation === "portrait" ? 1350 : 628,
      crop: "fill",
      gravity: "auto",
      overlay: {
        color: "#ffffff",
        font_family: "Arial",
        font_size: 40,
        font_weight: "bold",
        text: formatTextForOverlay(text, 50),
        gravity: "south",
        y: 30,
        background: "rgb:000000A0",
        padding: 15,
      },
    },
  };
}

/**
 * Format text for Cloudinary text overlay
 * Breaks text into lines with a maximum character count
 */
function formatTextForOverlay(text, maxCharsPerLine) {
  const words = text.split(" ");
  let lines = [];
  let currentLine = "";

  for (const word of words) {
    if ((currentLine + word).length > maxCharsPerLine) {
      lines.push(currentLine.trim());
      currentLine = word + " ";
    } else {
      currentLine += word + " ";
    }
  }

  if (currentLine.trim().length > 0) {
    lines.push(currentLine.trim());
  }

  return lines.join("\n");
}

/**
 * Generates a pretty HTML report of content opportunities
 * @param {Array} images - Array of images with content data
 * @param {Object} stats - Pipeline statistics
 * @returns {string} HTML content
 */
function generateContentReport(images, stats) {
  const timestamp = new Date().toISOString();
  const dateStr = new Date().toLocaleDateString();
  
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Retroscope Content Opportunities - ${dateStr}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; line-height: 1.6; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 12px; margin-bottom: 30px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: #f8f9fa; padding: 20px; border-radius: 8px; text-align: center; }
        .stat-number { font-size: 2rem; font-weight: bold; color: #667eea; }
        .opportunity { background: white; border: 1px solid #e9ecef; border-radius: 12px; padding: 25px; margin-bottom: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .opportunity img { max-width: 100%; height: auto; border-radius: 8px; margin-bottom: 15px; }
        .score { display: inline-block; background: #28a745; color: white; padding: 5px 12px; border-radius: 20px; font-weight: bold; margin-bottom: 10px; }
        .score.medium { background: #ffc107; color: #212529; }
        .score.low { background: #6c757d; }
        .pitches { background: #f8f9fa; padding: 15px; border-radius: 8px; margin-top: 15px; }
        .pitch { margin-bottom: 10px; padding: 10px; background: white; border-left: 4px solid #667eea; }
        .meta { color: #6c757d; font-size: 0.9rem; margin-top: 10px; }
        .footer { text-align: center; color: #6c757d; margin-top: 40px; padding-top: 20px; border-top: 1px solid #e9ecef; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎯 Content Opportunities Report</h1>
        <p>Generated on ${dateStr} • Found ${images.length} high-potential opportunities</p>
    </div>
    
    <div class="stats">
        <div class="stat-card">
            <div class="stat-number">${stats.totalAnalyzed}</div>
            <div>Images Analyzed</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${images.length}</div>
            <div>Opportunities Found</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.totalPitches}</div>
            <div>Content Pitches</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${Math.round(images.reduce((acc, img) => acc + img.score, 0) / images.length)}</div>
            <div>Average Score</div>
        </div>
    </div>
    
    ${images.map((image, index) => `
    <div class="opportunity">
        <h2>Content Opportunity #${index + 1}</h2>
        <div class="score ${image.score >= 80 ? 'high' : image.score >= 60 ? 'medium' : 'low'}">${image.score}/100</div>
        
        <img src="${image.url}" alt="Content opportunity ${index + 1}" loading="lazy">
        
        <h3>Why This Works</h3>
        <p><strong>${image.reason}</strong></p>
        
        <div class="meta">
            <strong>Target Audience:</strong> ${image.audience}<br>
            <strong>Best Platform:</strong> ${image.best_platform}<br>
            <strong>Image ID:</strong> ${image.id}<br>
            <strong>Created:</strong> ${new Date(image.created_at).toLocaleDateString()}
        </div>
        
        <div class="pitches">
            <h4>Content Pitch Ideas</h4>
            ${image.pitches.map(pitch => `<div class="pitch">💡 ${pitch}</div>`).join('')}
        </div>
    </div>
    `).join('')}
    
    <div class="footer">
        <p>Generated by Retroscope • ${timestamp}</p>
        <p>Ready to create content? Check your Cloudinary for images tagged "content_candidate"</p>
    </div>
</body>
</html>`;
  
  return html;
}

/**
 * Generates a markdown report of content opportunities
 * @param {Array} images - Array of images with content data
 * @param {Object} stats - Pipeline statistics
 * @returns {string} Markdown content
 */
function generateMarkdownReport(images, stats) {
  const timestamp = new Date().toISOString();
  const dateStr = new Date().toLocaleDateString();
  
  const markdown = `# 🎯 Content Opportunities Report

*Generated on ${dateStr}*

## 📊 Summary

- **Images Analyzed:** ${stats.totalAnalyzed}
- **Opportunities Found:** ${images.length}
- **Content Pitches Generated:** ${stats.totalPitches}
- **Average Score:** ${Math.round(images.reduce((acc, img) => acc + img.score, 0) / images.length)}/100

${images.map((image, index) => `
## Content Opportunity #${index + 1}

**Score:** ${image.score}/100 ${image.score >= 80 ? '🔥' : image.score >= 60 ? '⭐' : '💡'}

![Content opportunity ${index + 1}](${image.url})

**Why This Works:** ${image.reason}

**Target Audience:** ${image.audience}  
**Best Platform:** ${image.best_platform}  
**Image ID:** \`${image.id}\`  
**Created:** ${new Date(image.created_at).toLocaleDateString()}

### Content Pitch Ideas

${image.pitches.map(pitch => `- 💡 ${pitch}`).join('\n')}

---
`).join('')}

*Generated by Retroscope on ${timestamp}*
`;
  
  return markdown;
}

/**
 * Main content pipeline function
 */
async function runContentPipeline() {
  try {
    // Set a smaller number for testing
    const testMode = process.env.TEST_MODE === "true";
    const maxImages = testMode ? 20 : 100; // Reduced from 500 to 100
    const selectCount = testMode ? 3 : 5;
    const daysBack = testMode ? 30 : 7; // Look back 7 days in normal mode, 30 in test mode
    const forceRefresh = process.env.FORCE_REFRESH === "true" || false; // Force refresh cached content

    logger.info(
      `Running content pipeline in ${
        testMode ? "TEST MODE" : "NORMAL MODE"
      } (force refresh: ${forceRefresh})`
    );

    // 1. Get images with AI descriptions
    const images = await getImagesWithDescriptions(maxImages, daysBack);

    if (images.length === 0) {
      logger.info("No suitable images found for content creation");
      return;
    }

    // Clear cache if forced refresh
    if (forceRefresh) {
      logger.info("Force refresh enabled - clearing cached content data");
      images.forEach((image) => {
        image.cached_score = null;
        image.cached_reason = null;
        image.cached_audience = null;
        image.cached_platform = null;
        image.cached_pitches = null;
      });
    }

    // 2. Score images based on their content potential
    const scoredImages = await scoreImagesForContentValue(images);

    // 3. Select top images
    const selectedImages = selectTopImages(scoredImages, selectCount);
    logger.info(
      `Selected ${selectedImages.length} top images for content creation`
    );

    if (selectedImages.length === 0) {
      logger.info("No images met the quality threshold for content creation");
      return;
    }

    // 4. Generate content pitches for each selected image
    const imagesWithPitches = await Promise.all(
      selectedImages.map(async (image) => {
        const pitches = await generateContentPitches(image);
        return { ...image, pitches };
      })
    );

    // 5. Send content to Discord
    const discordSent = await sendContentToDiscord(imagesWithPitches);

    if (discordSent) {
      logger.info("Content pipeline completed successfully");

      // 6. Tag images as content candidates
      for (const image of selectedImages) {
        await cloudinary.uploader.explicit(image.id, {
          type: "upload",
          tags: [...(image.tags || []), "content_candidate"],
        });
      }

      // 7. Generate pretty reports
      const stats = {
        totalAnalyzed: images.length,
        totalPitches: imagesWithPitches.reduce((acc, img) => acc + img.pitches.length, 0)
      };
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      
      // Generate HTML report
      const htmlReport = generateContentReport(imagesWithPitches, stats);
      const htmlPath = `reports/content_opportunities_${timestamp}.html`;
      await fs.writeFile(htmlPath, htmlReport);
      
      // Generate Markdown report
      const markdownReport = generateMarkdownReport(imagesWithPitches, stats);
      const markdownPath = `reports/content_opportunities_${timestamp}.md`;
      await fs.writeFile(markdownPath, markdownReport);

      // Add satisfying user feedback
      console.log("\n🎯 CONTENT PIPELINE COMPLETE!");
      console.log(`🔍 Analyzed ${images.length} recent images`);
      console.log(`⭐ Found ${selectedImages.length} high-potential content opportunities`);
      console.log(`🎨 Generated ${imagesWithPitches.reduce((acc, img) => acc + img.pitches.length, 0)} content pitches`);
      console.log(`📤 Sent opportunities to Discord webhook`);
      console.log(`📄 Generated reports:`);
      console.log(`   • HTML: ${htmlPath}`);
      console.log(`   • Markdown: ${markdownPath}`);
      console.log("\n💡 Next steps:");
      console.log("• Check your Discord for the full content report");
      console.log(`• Open ${htmlPath} in your browser for a pretty report`);
      console.log("• Review images tagged as 'content_candidate' in Cloudinary");
    } else {
      console.log("\n❌ Content pipeline failed to send to Discord");
      console.log("Check your webhook configuration and try again");
    }
  } catch (error) {
    logger.error("Error in content pipeline:", error);
  }
}

// If called directly, run the pipeline
if (process.argv[1].endsWith("content-pipeline.js")) {
  // Check for test mode flag
  const testMode = process.argv.includes("--test");
  if (testMode) {
    process.env.TEST_MODE = "true";
    process.env.LOG_LEVEL = "debug";
    logger.info(
      "Running in TEST MODE with reduced image count and enhanced logging"
    );
  }

  // Check for force refresh flag
  const forceRefresh = process.argv.includes("--refresh");
  if (forceRefresh) {
    process.env.FORCE_REFRESH = "true";
    logger.info(
      "Force refresh mode enabled - will regenerate all content data"
    );
  }

  // Check for show-top flag
  const showTop = process.argv.includes("--show-top");
  if (showTop) {
    // Extract count from --show-top=N format
    const countArg = process.argv.find(arg => arg.startsWith("--show-top="));
    const count = countArg ? parseInt(countArg.split("=")[1]) : 10;
    
    showTopOpportunities(count).catch((error) => {
      logger.error("Fatal error showing top opportunities:", error);
      process.exit(1);
    });
  } else {
    runContentPipeline().catch((error) => {
      logger.error("Fatal error in content pipeline:", error);
      process.exit(1);
    });
  }
}

/**
 * Shows the top-scoring content opportunities
 * @param {number} count - Number of top images to show
 */
async function showTopOpportunities(count = 10) {
  try {
    console.log(`\n🔍 Finding your top ${count} content opportunities...\n`);
    
    // Get images with cached scores
    const images = await getImagesWithDescriptions(500, 30); // Look back 30 days
    
    // Filter for images that have been scored
    const scoredImages = images.filter(img => img.cached_score !== null);
    
    if (scoredImages.length === 0) {
      console.log("❌ No scored images found.");
      console.log("💡 Run 'npm run content' first to analyze and score your images");
      return;
    }
    
    // Sort by score and take top N
    const topImages = scoredImages
      .sort((a, b) => b.cached_score - a.cached_score)
      .slice(0, count);
    
    console.log(`📊 Found ${scoredImages.length} scored images, showing top ${topImages.length}:\n`);
    
    topImages.forEach((image, index) => {
      const emoji = image.cached_score >= 80 ? '🔥' : image.cached_score >= 60 ? '⭐' : '💡';
      
      console.log(`${emoji} #${index + 1} • Score: ${image.cached_score}/100`);
      console.log(`   Image: ${image.id}`);
      console.log(`   URL: ${image.url}`);
      console.log(`   Why: ${image.cached_reason || 'No reason cached'}`);
      console.log(`   Platform: ${image.cached_platform || 'Not specified'}`);
      console.log(`   Created: ${new Date(image.created_at).toLocaleDateString()}`);
      
      if (image.cached_pitches && image.cached_pitches.length > 0) {
        console.log(`   Pitches: ${image.cached_pitches.length} ideas available`);
        console.log(`   Preview: "${image.cached_pitches[0].substring(0, 60)}..."`);
      }
      console.log('');
    });
    
    console.log("💡 Want to see full details? Run 'npm run content' to generate a complete report");
    
  } catch (error) {
    logger.error("Error showing top opportunities:", error);
    console.log("❌ Failed to fetch top opportunities");
  }
}

// Export functions for use in other modules
export {
  getImagesWithDescriptions,
  scoreImagesForContentValue,
  generateContentPitches,
  sendContentToDiscord,
  generateFinalAssets,
  runContentPipeline,
  showTopOpportunities,
};
