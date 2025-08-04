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
app.use(express.static('public'));

// Help Scout dynamic app endpoint
app.get('/widget', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'widget.html'));
});

// API endpoint to evaluate responses
app.post('/api/evaluate', async (req, res) => {
  try {
    const { conversationId, customerId } = req.body;
    
    if (!conversationId) {
      return res.status(400).json({ error: 'Conversation ID required' });
    }

    // Get conversation details from Help Scout
    const conversation = await getHelpScoutConversation(conversationId);
    
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Find the latest team response
    const latestResponse = findLatestTeamResponse(conversation);
    
    if (!latestResponse) {
      return res.json({ 
        message: 'No team response found to evaluate',
        hasResponse: false 
      });
    }

    // Detect if this is about Shopify (app) or WordPress (plugin)
    const isShopify = detectShopifyContext(conversation);
    
    // Evaluate the response using OpenAI
    const evaluation = await evaluateResponse(latestResponse, conversation, isShopify);
    
    res.json({
      hasResponse: true,
      evaluation,
      responseText: latestResponse.text,
      isShopify
    });

  } catch (error) {
    console.error('Error evaluating response:', error);
    res.status(500).json({ 
      error: 'Failed to evaluate response',
      details: error.message 
    });
  }
});

// Get conversation from Help Scout API
async function getHelpScoutConversation(conversationId) {
  try {
    const response = await axios.get(
      `https://api.helpscout.net/v2/conversations/${conversationId}?embed=threads,tags`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.HELPSCOUT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Help Scout API error:', error.response?.data || error.message);
    return null;
  }
}

// Find the most recent response from a team member
function findLatestTeamResponse(conversation) {
  if (!conversation._embedded?.threads) {
    return null;
  }

  // Sort threads by creation date (newest first)
  const threads = [...conversation._embedded.threads].sort((a, b) => 
    new Date(b.createdAt) - new Date(a.createdAt)
  );

  // Find the latest thread from a user (team member)
  for (const thread of threads) {
    if (thread.type === 'reply' && thread.createdBy.type === 'user' && thread.body) {
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
  const tags = conversation._embedded?.tags || [];
  const hasShopifyTag = tags.some(tag => 
    tag.name.toLowerCase().includes('shopify')
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});