# Help Scout Response Evaluator

A Help Scout dynamic app widget that evaluates support team responses using AI and provides feedback based on your support tone guidelines.

## Features

- **Automatic Response Analysis** - Evaluates the latest team response in Help Scout tickets
- **Smart Product Detection** - Automatically detects Shopify vs WordPress context from ticket tags
- **Detailed Scoring** - Rates responses on tone, clarity, English quality, problem resolution, and structure
- **Actionable Feedback** - Provides specific suggestions for improvement
- **Support Guidelines Integration** - Checks compliance with your specific support tone requirements

## Quick Start

1. **Deploy to Fly.io** (see setup instructions below)
2. **Set up Help Scout integration** 
3. **Add as sidebar widget in Help Scout**

## Setup Instructions

See the detailed setup guide for step-by-step instructions on:
- Creating GitHub repository
- Setting up Fly.io deployment
- Configuring Help Scout API access
- Adding the widget to Help Scout

## API Endpoints

- `GET /widget` - Serves the Help Scout widget
- `POST /api/evaluate` - Evaluates a conversation response

## Environment Variables

- `OPENAI_API_KEY` - Your OpenAI API key
- `HELPSCOUT_ACCESS_TOKEN` - Help Scout API access token
- `PORT` - Server port (set automatically by Fly.io)

## Local Development

```bash
npm install
cp .env.example .env
# Add your API keys to .env
npm run dev
```

Visit `http://localhost:3000/widget` to test the widget.