const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Help Scout webhook endpoint - this is what Help Scout calls
app.post('/widget', async (req, res) => {
  try {
    console.log('Help Scout webhook data:', req.body);
    
    // Help Scout sends conversation data in the request
    const helpScoutData = req.body;
    
    if (!helpScoutData.conversation) {
      return res.send(`
        <div style="padding: 20px; font-family: Arial, sans-serif;">
          <h3>Response Evaluator</h3>
          <p>No conversation data received from Help Scout.</p>
          <p>Debug info: ${JSON.stringify(helpScoutData)}</p>
        </div>
      `);
    }

    // Find the latest team response
    const conversation = helpScoutData.conversation;
    const latestResponse = findLatestTeamResponse(conversation);
    
    if (!latestResponse) {
      return res.send(`
        <div style="padding: 20px; font-family: Arial, sans-serif;">
          <h3>📊 Response Evaluator</h3>
          <p>No team response found to evaluate in this conversation.</p>
        </div>
      `);
    }

    // Detect if this is about Shopify (app) or WordPress (plugin)
    const isShopify = detectShopifyContext(conversation);
    
    // Evaluate the response using OpenAI
    const evaluation = await evaluateResponse(latestResponse, conversation, isShopify);
    
    // Return HTML for Help Scout sidebar
    const html = generateEvaluationHTML(evaluation, isShopify);
    res.send(html);

  } catch (error) {
    console.error('Error evaluating response:', error);
    res.send(`
      <div style="padding: 20px; font-family: Arial, sans-serif;">
        <h3>📊 Response Evaluator</h3>
        <p style="color: red;">Error: ${error.message}</p>
      </div>
    `);
  }
});

// Serve static widget for testing
app.get('/widget', (req, res) => {
  res.send(`
    <div style="padding: 20px; font-family: Arial, sans-serif;">
      <h3>📊 Response Evaluator</h3>
      <p>Widget is running! This endpoint should be called by Help Scout with POST data.</p>
      <p>Current time: ${new Date().toISOString()}</p>
    </div>
  `);
});

// Find the most recent response from a team member
function findLatestTeamResponse(conversation) {
  if (!conversation.threads) {
    return null;
  }

  // Sort threads by creation date (newest first)
  const threads = [...conversation.threads].sort((a, b) => 
    new Date(b.createdAt) - new Date(a.createdAt)
  );

  // Find the latest thread from a user (team member)
  for (const thread of threads) {
    if (thread.type === 'reply' && thread.createdBy && thread.createdBy.type === 'user' && thread.body) {
      return {
        text: thread.body,
        createdAt: thread.createdAt,
        createdBy: thread.createdBy
      };
    }
  }

  return null;
}

// Detect if this is a Shopify context
function detectShopifyContext(conversation) {
  // Check tags
  const tags = conversation.tags || [];
  const hasShopifyTag = tags.some(tag => 
    tag.name && tag.name.toLowerCase().includes('shopify')
  );

  if (hasShopifyTag) return true;

  // Check conversation content for Shopify mentions
  const allText = JSON.stringify(conversation).toLowerCase();
  return allText.includes('shopify') || allText.includes('shopify app');
}

// Evaluate response using OpenAI
async function evaluateResponse(response, conversation, isShopify) {
  const productType = isShopify ? 'app' : 'plugin';
  
  const prompt = `
You are evaluating a customer support response based on these specific guidelines:

SUPPORT TONE REQUIREMENTS:
1. MUST start by thanking the customer
2. MUST end with a polite closing (e.g., "Let me know if you have any questions")
3. Should suggest workarounds when saying something isn't possible
4. Only apologize when the company has done something wrong
5. Use positive language (avoid "but" and "however")
6. Include relevant links when mentioning features or documentation
7. Use "${productType}" not "${isShopify ? 'plugin' : 'app'}" (this is a ${isShopify ? 'Shopify' : 'WordPress'} product)
8. Focus on being helpful and reassuring, especially for pre-sales

RESPONSE TO EVALUATE:
"${response.text}"

Please evaluate this response on these criteria:
1. Tone & Empathy (follows support tone guidelines, thanks customer, polite closing)
2. Clarity & Completeness (clear, direct answers, addresses all questions)
3. Standard of English (grammar, spelling, natural phrasing for non-native speakers)
4. Problem Resolution (addresses actual customer needs, suggests solutions)
5. Following Structure (proper greeting, closing, correct terminology)

For each category, provide:
- Score out of 10
- Specific feedback (what was good, what needs improvement)

Then provide an overall score out of 10 and 2-3 key suggestions for improvement.

Format as JSON with this structure:
{
  "overall_score": 8.5,
  "categories": {
    "tone_empathy": {
      "score": 9,
      "feedback": "Great empathetic tone, thanked customer at start"
    },
    "clarity_completeness": {
      "score": 8,
      "feedback": "Clear explanation but could be more concise"
    },
    "standard_of_english": {
      "score": 7,
      "feedback": "'We are not able' would be more natural as 'We're unable to'"
    },
    "problem_resolution": {
      "score": 8,
      "feedback": "Addressed the issue but could suggest more alternatives"
    },
    "following_structure": {
      "score": 9,
      "feedback": "Good structure, but said 'plugin' instead of '${productType}'"
    }
  },
  "key_improvements": [
    "Remember to use '${productType}' instead of '${isShopify ? 'plugin' : 'app'}'",
    "Add a link to the relevant documentation",
    "Consider suggesting an alternative approach"
  ]
}`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are an expert at evaluating customer support responses. Always respond with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 1000
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const content = response.data.choices[0].message.content;
    return JSON.parse(content);
  } catch (error) {
    console.error('OpenAI API error:', error.response?.data || error.message);
    throw new Error('Failed to evaluate response with AI');
  }
}

// Generate HTML for Help Scout sidebar
function generateEvaluationHTML(evaluation, isShopify) {
  const productType = isShopify ? 'Shopify App' : 'WordPress Plugin';
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Response Evaluation</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px;
                line-height: 1.4;
                color: #333;
                background: #fff;
                margin: 0;
                padding: 16px;
            }
            .header {
                margin-bottom: 16px;
                padding-bottom: 12px;
                border-bottom: 1px solid #e8e8e8;
            }
            .header h3 {
                font-size: 14px;
                font-weight: 600;
                color: #2c5aa0;
                margin: 0;
            }
            .overall-score {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 20px;
                padding: 16px;
                background: #f8f9fa;
                border-radius: 8px;
            }
            .score-circle {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 50px;
                height: 50px;
                border-radius: 50%;
                background: ${evaluation.overall_score >= 8 ? '#10a54a' : evaluation.overall_score >= 6 ? '#2c5aa0' : '#d63638'};
                color: white;
                font-weight: bold;
                margin-right: 12px;
                font-size: 16px;
            }
            .category {
                margin-bottom: 12px;
                padding: 10px;
                background: #f8f9fa;
                border-radius: 6px;
                border-left: 3px solid #2c5aa0;
            }
            .category-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 4px;
            }
            .category-name {
                font-weight: 600;
                font-size: 11px;
                color: #333;
            }
            .category-score {
                background: ${evaluation.overall_score >= 8 ? '#10a54a' : evaluation.overall_score >= 6 ? '#2c5aa0' : '#d63638'};
                color: white;
                padding: 2px 6px;
                border-radius: 10px;
                font-size: 10px;
                font-weight: bold;
            }
            .category-feedback {
                font-size: 10px;
                color: #666;
                line-height: 1.3;
            }
            .improvements {
                margin-top: 16px;
                padding: 12px;
                background: #fff9e6;
                border-radius: 6px;
                border-left: 3px solid #f0b90b;
            }
            .improvements h4 {
                font-size: 11px;
                margin: 0 0 8px 0;
                color: #333;
            }
            .improvements ul {
                list-style: none;
                margin: 0;
                padding: 0;
            }
            .improvements li {
                font-size: 10px;
                color: #666;
                margin-bottom: 4px;
                padding-left: 10px;
                position: relative;
            }
            .improvements li:before {
                content: "•";
                position: absolute;
                left: 0;
                color: #f0b90b;
                font-weight: bold;
            }
            .product-type {
                text-align: center;
                color: #999;
                font-size: 10px;
                padding-top: 12px;
                border-top: 1px solid #e8e8e8;
                margin-top: 12px;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h3>📊 Response Evaluation</h3>
        </div>
        
        <div class="overall-score">
            <div class="score-circle">${evaluation.overall_score.toFixed(1)}</div>
            <div class="score-label">Overall Score</div>
        </div>
        
        <div class="category">
            <div class="category-header">
                <span class="category-name">Tone & Empathy</span>
                <span class="category-score">${evaluation.categories.tone_empathy.score}/10</span>
            </div>
            <div class="category-feedback">${evaluation.categories.tone_empathy.feedback}</div>
        </div>
        
        <div class="category">
            <div class="category-header">
                <span class="category-name">Clarity & Completeness</span>
                <span class="category-score">${evaluation.categories.clarity_completeness.score}/10</span>
            </div>
            <div class="category-feedback">${evaluation.categories.clarity_completeness.feedback}</div>
        </div>
        
        <div class="category">
            <div class="category-header">
                <span class="category-name">Standard of English</span>
                <span class="category-score">${evaluation.categories.standard_of_english.score}/10</span>
            </div>
            <div class="category-feedback">${evaluation.categories.standard_of_english.feedback}</div>
        </div>
        
        <div class="category">
            <div class="category-header">
                <span class="category-name">Problem Resolution</span>
                <span class="category-score">${evaluation.categories.problem_resolution.score}/10</span>
            </div>
            <div class="category-feedback">${evaluation.categories.problem_resolution.feedback}</div>
        </div>
        
        <div class="category">
            <div class="category-header">
                <span class="category-name">Following Structure</span>
                <span class="category-score">${evaluation.categories.following_structure.score}/10</span>
            </div>
            <div class="category-feedback">${evaluation.categories.following_structure.feedback}</div>
        </div>
        
        <div class="improvements">
            <h4>🎯 Key Improvements</h4>
            <ul>
                ${evaluation.key_improvements.map(improvement => `<li>${improvement}</li>`).join('')}
            </ul>
        </div>
        
        <div class="product-type">
            Detected: ${productType}
        </div>
    </body>
    </html>
  `;
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});