# 👁️ RETROSCOPE 📸

```
 ____      _                                      
|  _ \ ___| |_ _ __ ___  ___  ___ ___  _ __  ___ 
| |_) / _ \ __| '__/ _ \/ __|/ __/ _ \| '_ \/ __|
|  _ <  __/ |_| | | (_) \__ \ (_| (_) | |_) \__ \
|_| \_\___|\__|_|  \___/|___/\___\___/| .__/|___/
                                      |_|         
```

**Turn your forgotten screenshots into content gold.**

Retroscope is your AI-powered personal archivist that transforms your digital breadcrumbs into strategic content opportunities. It crawls through your Cloudinary photo library, intelligently analyzes every screenshot and image with Google's Gemini Vision, and serves up ready-made content pitches for your best visual moments.

## What It Actually Does

🔍 **The Detective**: Finds all those screenshots you forgot about and extracts EXACTLY what's in them - every button label, error message, code snippet, and piece of UI text.

📊 **The Curator**: Scores each image (0-100) on storytelling potential, uniqueness, and social shareability. No more guessing which random screenshot could go viral.

🎯 **The Pitch Machine**: Generates multiple content angles written in your voice: "This bug you found could be a great Twitter thread about dev tools."

⚙️ **The Automation**: Runs continuously on Docker, sending you daily reports of your best content opportunities via Discord/webhooks.

**Perfect for**: Developers, designers, and creators who capture tons of screenshots but never know which ones are worth sharing.

## Real-World Examples

**Before Retroscope**: You have 2,847 screenshots sitting in Cloudinary. Mostly forgotten.

**After Retroscope**: 
- "That error message you screenshotted last week? It's scored 87/100 for content potential - here are 4 Twitter thread ideas about debugging workflows."
- "Your config file screenshot could be an Instagram post about clean code practices."
- "That dashboard you built has 3 LinkedIn post angles about data visualization."

## Technical Features

- **Intelligent Text Extraction**: Captures exact UI text, error messages, and code snippets from screenshots
- **Smart Content Scoring**: AI evaluates visual uniqueness, storytelling potential, and social shareability (0-100)
- **Voice-Matched Pitches**: Generates content ideas that sound like you, not a marketing bot
- **Cost Efficient**: ~1.7¢ per image analysis with detailed usage tracking
- **Production Ready**: Docker deployment with health checks, logging, and automated scheduling

## Quick Start

```bash
# Clone and install
git clone https://github.com/yourusername/retroscope.git
cd retroscope
npm install

# Set up your API keys
cp .env.example .env
# Edit .env with your Cloudinary and Google API credentials

# Test with 5 images
npm start -- --n=5 --verbose

# Run content pipeline to get pitches
npm run content
```

**First run?** Retroscope will analyze your most recent images and show you exactly what it found. Look for the detailed console output - it's quite satisfying to see it extract text from screenshots you'd forgotten about.

## Docker Deployment

The application can be run in a Docker container with automated scheduling. This is the recommended way to deploy Retroscope in production.

### Prerequisites

- Docker
- Docker Compose v2.x or higher

### Setup

1. Clone the repository and configure environment:
```bash
git clone https://github.com/yourusername/retroscope.git
cd retroscope
cp .env.example .env
```

2. Edit `.env` with your credentials:
```env
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
GOOGLE_API_KEY=your_gemini_api_key
```

3. Start the containers:
```bash
# Build and start in detached mode
docker compose up -d --build

# Verify containers are running and healthy
docker compose ps
```

This will start two containers:
- `retroscope`: The main application container with health monitoring
- `scheduler`: An Ofelia scheduler that runs the app on a schedule

### Production Configuration

The Docker setup includes several production-ready features:

- **Health Checks**: Both containers are monitored for health status
- **Logging**: JSON log files with rotation (100MB max size, 3 files kept)
- **Security**: Non-root user in containers
- **Resource Management**: Automatic container restarts on failure
- **Error Handling**: Job overlap prevention and timeout settings

### Scheduling

The application runs at 50 minutes past every hour by default, processing up to 100 images per run. Configuration is in `config/ofelia.ini`:

```ini
[global]
smtp-host = ""  # Disable email notifications

[job-exec "process-images"]
schedule = 0 50 * * * *  # Run at 50 minutes past every hour
container = retroscope_retroscope_1
command = npm start -- --n=100 --verbose
no-overlap = true
on-error = "continue"
timeout = 45m  # Maximum runtime of 45 minutes
```

Common schedule patterns:
- `0 50 * * * *`: Every hour at minute 50 (default)
- `0 */30 * * * *`: Every 30 minutes
- `0 0 */2 * * *`: Every 2 hours at minute 0
- `0 0 0 * * *`: Once per day at midnight

### Monitoring

Monitor the application's health and logs:

```bash
# Check container health status
docker compose ps

# View application logs
docker compose logs retroscope

# View scheduler logs
docker compose logs scheduler

# Follow all logs in real-time
docker compose logs -f

# View specific container's last 100 lines
docker compose logs --tail=100 retroscope
```

### Maintenance

To update the application:

```bash
# Pull latest changes
git pull

# Rebuild and restart containers
docker compose down
docker compose up -d --build

# Verify health
docker compose ps
```

To stop the application:
```bash
docker compose down
```

For debugging:
```bash
# View detailed container information
docker compose ps -a

# Check container resource usage
docker stats

# Enter container for debugging
docker compose exec retroscope /bin/bash
```

## Environment Variables

```env
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
GOOGLE_API_KEY=your_gemini_api_key
```

## Usage Examples

```bash
# Basic image analysis (processes 10 images)
npm start -- --n=10

# Get detailed output to see what it finds
npm start -- --n=10 --verbose

# Content pipeline: find your best content opportunities
npm run content

# Force fresh analysis of already processed images
npm start -- --n=10 --reprocess

# Export all your analyzed images as JSON
npm start -- --export

# Export with date range
npm start -- --export --export-from="2024-01-01" --export-to="2024-12-31"

# Test mode: smaller batch for trying things out
npm run content:test
```

**Pro tip**: Start with `--verbose` to see exactly what text Retroscope extracts from your screenshots. It's surprisingly thorough.

## What You Actually Get

### Screenshot Analysis Example
```
Image: screenshot_2024_config_panel.png
Score: 87/100

AI Description:
"Screenshot of a development configuration panel showing deployment settings for a Node.js application. The interface displays environment variables including 'PORT=4242', 'NODE_ENV=production', and various API keys. The left sidebar shows navigation options for 'Database', 'Monitoring', and 'Security'. A green 'Deploy' button is prominent in the top right, with status indicator showing 'Ready for deployment'. The panel includes form fields for custom domain configuration and SSL certificate settings."

Content Pitches:
• "Behind the scenes of shipping production Node.js apps - here's how I structure environment configs for zero-downtime deployments"
• "This simple config panel pattern has saved me hours of debugging production issues"  
• "Why I always separate staging and production environment variables (and you should too)"
```

### Photo Analysis Example  
```
Image: sunset_coding_session.jpg
Score: 92/100

AI Description:
"Photograph of a laptop displaying code on a wooden desk during golden hour. The screen shows a text editor with JavaScript code, featuring syntax highlighting in a dark theme. Warm sunlight creates dramatic shadows across the keyboard and creates a cozy, productive atmosphere. A coffee mug and small succulent plant are visible in the background."

Content Pitches:
• "Golden hour coding hits different - why I do my best debugging work at sunset"
• "This lighting setup for dev content creation cost me $0 (just good timing)"
• "The psychology of environment in programming: how natural light affects code quality"
```

## Getting Your Data Out

All the AI analysis gets stored in your Cloudinary metadata, so you own it completely. Here's how to access your analyzed images:

```javascript
import { v2 as cloudinary } from 'cloudinary';

// Initialize Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Fetch images with their AI descriptions
async function getAnalyzedImages() {
  const images = [];
  let nextCursor = null;

  do {
    const result = await new Promise((resolve, reject) => {
      cloudinary.api.resources({
        type: 'upload',
        max_results: 500,
        next_cursor: nextCursor,
        tags: true,
        context: true,  // Important: This gets the metadata
      }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });

    // Transform and filter images
    const pageImages = result.resources
      .filter(res => res.tags?.includes('ai_processed'))
      .map(resource => ({
        id: resource.public_id,
        url: resource.secure_url,
        created_at: resource.created_at,
        // The AI description is stored here:
        description: resource.context?.custom?.ai_description || null,
        analyzed_at: resource.context?.custom?.updated_at || null,
      }));

    images.push(...pageImages);
    nextCursor = result.next_cursor;
  } while (nextCursor);

  return images;
}

// Example usage:
const images = await getAnalyzedImages();
console.log(`Found ${images.length} analyzed images`);
```

### Cloudinary Metadata Structure

The AI descriptions are stored in:
- `context.custom.ai_description`: The full AI-generated description
- `context.custom.updated_at`: Timestamp of the analysis
- `tags`: Includes "ai_processed" for processed images

Example response structure:
```javascript
{
  public_id: "example_image",
  secure_url: "https://...",
  context: {
    custom: {
      ai_description: "Detailed analysis of the image...",
      updated_at: "2024-01-02T02:44:10.158Z"
    }
  },
  tags: ["ai_processed"],
  // ... other Cloudinary fields
}
```

## License

MIT

## Grafana Queries

### Cost Tracking
```logql
# Total cost over time
sum(rate({job="retroscope"} |= "METRIC:processing_cost" | json | unwrap metric_value [1m]))

# Average cost per image type
avg by (is_screenshot) (
  {job="retroscope"} |= "METRIC:processing_cost" 
  | json 
  | unwrap metric_value
)
```

### Processing Speed
```logql
# Images processed per minute
sum(rate({job="retroscope"} |= "METRIC:images_per_second" | json | unwrap metric_value [1m]))

# Processing duration histogram
{job="retroscope"} |= "METRIC:processing_speed"
| json
| unwrap total_duration
| histogram duration_seconds
```

### Token Usage
```logql
# Token usage by image type
sum by (is_screenshot) (
  {job="retroscope"} |= "METRIC:tokens_used"
  | json
  | unwrap metric_value
)

# Average tokens per image over time
avg(rate({job="retroscope"} |= "METRIC:tokens_used" | json | unwrap metric_value [5m]))
```

### Error Tracking
```logql
# Error rate
sum(rate({job="retroscope", level="error"} [5m]))

# Failed images count
{job="retroscope"} |= "METRIC:total_cost"
| json
| unwrap failed_images
```

### Success Rate
```logql
# Successful vs failed processing ratio
sum by (success) (
  {job="retroscope"} |= "METRIC:processing_cost"
  | json
  | unwrap metric_value
)
```

These queries can be used to create dashboards showing:
- Cost per image/batch
- Processing speed and efficiency
- Token usage patterns
- Error rates and types
- Success/failure ratios