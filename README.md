# 👁️ RETROSCOPE 📸

```
 ____      _                                      
|  _ \ ___| |_ _ __ ___  ___  ___ ___  _ __  ___ 
| |_) / _ \ __| '__/ _ \/ __|/ __/ _ \| '_ \/ __|
|  _ <  __/ |_| | | (_) \__ \ (_| (_) | |_) \__ \
|_| \_\___|\__|_|  \___/|___/\___\___/| .__/|___/
                                      |_|         
```

AI-powered image analysis tool that processes images from Cloudinary using Google's Gemini Vision API to generate detailed descriptions. Handles both screenshots and photographs intelligently.

## Features

- Analyzes screenshots with focus on UI/functionality and exact text capture
- Processes photographs with focus on composition and visual details
- Stores descriptions in Cloudinary metadata
- Smart token usage (16K for screenshots, 32K for photos)
- Detailed cost tracking (~1.7¢ per image)
- Rate limiting and pagination handling

## Installation

```bash
# Clone and install
git clone https://github.com/yourusername/retroscope.git
cd retroscope
npm install

# Copy and configure environment variables
cp .env.example .env
```

## Environment Variables

```env
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
GOOGLE_API_KEY=your_gemini_api_key
```

## Usage

```bash
# Process 10 images
npm start -- --n=10

# Process with verbose logging
npm start -- --n=10 --verbose

# Force reprocess already analyzed images
npm start -- --n=10 --reprocess

# Export all analyzed images
npm start -- --export

# Export with date range
npm start -- --export --export-from="2024-01-01" --export-to="2024-12-31"
```

## Accessing AI Descriptions

The AI-generated descriptions are stored in Cloudinary's metadata. Here's how to access them:

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