# Complete Setup Guide for Help Scout Response Evaluator

This guide will walk you through setting up your Help Scout response evaluation widget from start to finish.

## 🔐 FIRST: Secure Your OpenAI API Key

**IMPORTANT**: The API key you shared is now exposed publicly. You must:

1. Go to https://platform.openai.com/api-keys
2. Click on the key that starts with "sk-proj-nzX..."
3. Click "Delete" to revoke it
4. Click "Create new secret key"
5. Copy the new key and keep it safe (you'll need it later)

## 📋 What You'll Need for Help Scout API

To access Help Scout's API, you need to create an OAuth2 application:

1. **Go to Help Scout Developer Settings**:
   - Log into Help Scout
   - Go to Profile → Developer → My Apps
   - Click "Create App"

2. **App Settings**:
   - **App Name**: "Response Evaluator"
   - **Redirection URL**: `https://your-app-name.fly.dev/auth/callback` (you'll update this later)
   - **App Type**: Choose "Dynamic App"

3. **Copy These Values** (you'll need them):
   - App ID
   - App Secret

## 🚀 Step 1: Set Up GitHub Repository

1. **Create New Repository**:
   - Go to https://github.com
   - Click "New repository"
   - Repository name: `helpscout-response-evaluator`
   - Make it **Private**
   - Don't initialize with README (we have files ready)
   - Click "Create repository"

2. **Upload Your Files**:
   - Download all the files I created from `/Users/katiekeith/Documents/helpscout-response-evaluator/`
   - On your new GitHub repo page, click "uploading an existing file"
   - Drag and drop all files EXCEPT `.env.example` (don't upload the example file)
   - Commit message: "Initial commit - Help Scout response evaluator"
   - Click "Commit changes"

## 🛩️ Step 2: Set Up Fly.io

1. **Install Fly CLI** (if you don't have it):
   - Go to https://fly.io/docs/hands-on/install-flyctl/
   - Follow instructions for Mac
   - Run `flyctl auth login` in Terminal

2. **Deploy Your App**:
   ```bash
   # Navigate to your project folder
   cd /Users/katiekeith/Documents/helpscout-response-evaluator
   
   # Create Fly app (choose a unique name)
   flyctl apps create helpscout-response-evaluator-katie
   
   # Set your environment variables (use your NEW OpenAI key)
   flyctl secrets set OPENAI_API_KEY="your-new-openai-key-here"
   flyctl secrets set HELPSCOUT_ACCESS_TOKEN="your-helpscout-token-here"
   
   # Deploy the app
   flyctl deploy
   ```

3. **Get Your App URL**:
   - After deployment, Fly will show you a URL like: `https://helpscout-response-evaluator-katie.fly.dev`
   - Copy this URL - you'll need it for Help Scout

## 🎯 Step 3: Configure Help Scout Integration

1. **Update Your Help Scout App**:
   - Go back to Help Scout Developer settings
   - Edit your app
   - Update **Redirection URL** to: `https://your-app-name.fly.dev/auth/callback`

2. **Set Up Dynamic App**:
   - In your Help Scout app settings
   - Go to "Dynamic Content" tab
   - Add new dynamic content:
     - **Name**: "Response Evaluation"
     - **Placement**: "Sidebar"
     - **URL**: `https://your-app-name.fly.dev/widget`
     - **Height**: 400px

3. **Install App in Help Scout**:
   - Go to Help Scout → Apps
   - Find your "Response Evaluator" app
   - Click "Install"

## 🧪 Step 4: Test Your Widget

1. **Open a Help Scout Ticket**:
   - Find any ticket with team responses
   - Look for your "Response Evaluation" widget in the sidebar
   - It should automatically analyze the latest response

2. **Check for Shopify Detection**:
   - Test with a ticket tagged "Shopify" - should say "app"
   - Test with a WordPress ticket - should say "plugin"

## 🔧 Troubleshooting

**Widget Not Loading?**
- Check Fly.io logs: `flyctl logs`
- Verify your API keys are set: `flyctl secrets list`

**"No conversation ID found"?**
- Help Scout might need a few minutes to propagate the integration
- Try refreshing the ticket page

**OpenAI API Errors?**
- Ensure your new API key is valid and has credits
- Check you've set it correctly: `flyctl secrets list`

**Help Scout API Errors?**
- Verify your Help Scout access token is correct
- Check the app has proper permissions in Help Scout settings

## 💰 Costs

**Fly.io**: Likely free (small app, minimal usage)
**OpenAI**: ~$0.01-0.05 per evaluation (very low cost)

## 🔄 Making Updates

To update your widget:
1. Make changes to your files
2. Update the GitHub repository
3. Run `flyctl deploy` to redeploy

## 📞 Need Help?

If you get stuck:
1. Check Fly.io logs: `flyctl logs`
2. Check the browser console in Help Scout for JavaScript errors
3. Verify all API keys are correctly set

Your widget should now be working! It will automatically evaluate team responses and provide feedback based on your support tone guidelines.