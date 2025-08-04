const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Help Scout dynamic app endpoint
app.post('/', async (req, res) => {
  try {
    console.log('=== Help Scout Request ===');
    const { ticket, customer, user, mailbox } = req.body;
    
    if (!ticket || !ticket.id) {
      return res.json({
        html: '<div style="padding: 20px;">No ticket data received.</div>'
      });
    }

    // Get conversation threads from Help Scout API
    const conversation = await getHelpScoutConversation(ticket.id);
    
    if (!conversation) {
      return res.json({
        html: `
          <div style="padding: 20px; font-family: Arial, sans-serif;">
            <h3>📊 Response Evaluator</h3>
            <p>Could not fetch conversation data.</p>
            <p>Ticket: #${ticket.number}</p>
          </div>
        `
      });
    }

    // Find the latest team response
    const latestResponse = findLatestTeamResponse(conversation);
    
    if (!latestResponse) {
      return res.json({
        html: `
          <div style="padding: 20px; font-family: Arial, sans-serif;">
            <h3>📊 Response Evaluator</h3>
            <p>No team response found to evaluate.</p>
            <p>Ticket: #${ticket.number}</p>
          </div>
        `
      });
    }

    // Detect if this is about Shopify (app) or WordPress (plugin)
    const isShopify = detectShopifyContext(conversation);
    
    // Evaluate the response using OpenAI
    const evaluation = await evaluateResponse(latestResponse, conversation, isShopify);
    
    // Generate HTML with evaluation results
    const html = generateEvaluationHTML(evaluation, isShopify, ticket, customer);
    
    res.json({ html });

  } catch (error) {
    console.error('Error:', error);
    res.json({
      html: `
        <div style="padding: 20px; font-family: Arial, sans-serif;">
          <h3>📊 Response Evaluator</h3>
          <p style="color: red;">Error: ${error.message}</p>
        </div>
      `
    });
  }
});

// Get conversation from Help Scout API
async function getHelpScoutConversation(conversationId) {
  try {
    // First try with App ID/Secret (OAuth2)
    let accessToken = process.env.HELPSCOUT_ACCESS_TOKEN;
    
    if (!accessToken) {
      // If no access token, try to get one using App ID/Secret
      console.log('Attempting to get OAuth token...');
      console.log('App ID exists:', !!process.env.HELPSCOUT_APP_ID);
      console.log('App Secret exists:', !!process.env.HELPSCOUT_APP_SECRET);
      
      const authResponse = await axios.post('https://api.helpscout.net/v2/oauth2/token', {
        grant_type: 'client_credentials',
        client_id: process.env.HELPSCOUT_APP_ID,
        client_secret: process.env.HELPSCOUT_APP_SECRET
      }, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      console.log('OAuth token response:', authResponse.data);
      accessToken = authResponse.data.access_token;
    }

    // First test basic API access
    console.log('Testing basic API access...');
    const testResponse = await axios.get('https://api.helpscout.net/v2/users/me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('Basic API test successful:', testResponse.data.firstName);
    
    console.log('Fetching conversation ID:', conversationId);
    
    // Try without embed parameters first
    let apiUrl = `https://api.helpscout.net/v2/conversations/${conversationId}`;
    console.log('API URL (basic):', apiUrl);
    
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Basic conversation fetch successful');
    
    // If basic works, try with threads
    apiUrl = `https://api.helpscout.net/v2/conversations/${conversationId}/threads`;
    console.log('Fetching threads from:', apiUrl);
    
    const threadsResponse = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Threads fetch successful');
    console.log('Number of threads:', threadsResponse.data._embedded?.threads?.length || 0);
    
    // Log thread details
    if (threadsResponse.data._embedded?.threads) {
      threadsResponse.data._embedded.threads.forEach((thread, index) => {
        console.log(`Thread ${index}:`, {
          type: thread.type,
          createdBy: thread.createdBy?.type,
          hasBody: !!thread.body
        });
      });
    }
    
    // Combine the data
    const conversationData = response.data;
    conversationData._embedded = { threads: threadsResponse.data._embedded?.threads || [] };
    
    return conversationData;
    
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

  const threads = [...conversation._embedded.threads].sort((a, b) => 
    new Date(b.createdAt) - new Date(a.createdAt)
  );

  for (const thread of threads) {
    if (thread.type === 'reply' && thread.createdBy?.type === 'user' && thread.body) {
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
  const tags = conversation._embedded?.tags || [];
  const hasShopifyTag = tags.some(tag => 
    tag.name && tag.name.toLowerCase().includes('shopify')
  );

  if (hasShopifyTag) return true;

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
      "feedback": "Good structure, used correct terminology"
    }
  },
  "key_improvements": [
    "Consider suggesting an alternative approach",
    "Add a link to the relevant documentation",
    "Use more natural phrasing"
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
function generateEvaluationHTML(evaluation, isShopify, ticket, customer) {
  const productType = isShopify ? 'Shopify App' : 'WordPress Plugin';
  
  return `
    <div style="font-family: Arial, sans-serif; font-size: 11px; padding: 16px; max-width: 300px;">
      <h3 style="color: #2c5aa0; font-size: 13px; margin: 0 0 12px 0;">📊 Response Evaluation</h3>
      
      <div style="display: flex; align-items: center; justify-content: center; margin-bottom: 16px; padding: 12px; background: #f8f9fa; border-radius: 6px;">
        <div style="display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 50%; background: ${evaluation.overall_score >= 8 ? '#10a54a' : evaluation.overall_score >= 6 ? '#2c5aa0' : '#d63638'}; color: white; font-weight: bold; margin-right: 8px; font-size: 14px;">
          ${evaluation.overall_score.toFixed(1)}
        </div>
        <div style="font-weight: 600; font-size: 11px;">Overall Score</div>
      </div>
      
      <div style="margin-bottom: 12px;">
        <div style="margin-bottom: 8px; padding: 8px; background: #f8f9fa; border-radius: 4px; border-left: 2px solid #2c5aa0;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 600; font-size: 10px;">Tone & Empathy</span>
            <span style="background: ${evaluation.categories.tone_empathy.score >= 8 ? '#10a54a' : '#2c5aa0'}; color: white; padding: 1px 4px; border-radius: 8px; font-size: 9px;">${evaluation.categories.tone_empathy.score}/10</span>
          </div>
          <div style="font-size: 9px; color: #666; line-height: 1.2;">${evaluation.categories.tone_empathy.feedback}</div>
        </div>
        
        <div style="margin-bottom: 8px; padding: 8px; background: #f8f9fa; border-radius: 4px; border-left: 2px solid #2c5aa0;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 600; font-size: 10px;">Clarity & Completeness</span>
            <span style="background: ${evaluation.categories.clarity_completeness.score >= 8 ? '#10a54a' : '#2c5aa0'}; color: white; padding: 1px 4px; border-radius: 8px; font-size: 9px;">${evaluation.categories.clarity_completeness.score}/10</span>
          </div>
          <div style="font-size: 9px; color: #666; line-height: 1.2;">${evaluation.categories.clarity_completeness.feedback}</div>
        </div>
        
        <div style="margin-bottom: 8px; padding: 8px; background: #f8f9fa; border-radius: 4px; border-left: 2px solid #2c5aa0;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 600; font-size: 10px;">Standard of English</span>
            <span style="background: ${evaluation.categories.standard_of_english.score >= 8 ? '#10a54a' : '#2c5aa0'}; color: white; padding: 1px 4px; border-radius: 8px; font-size: 9px;">${evaluation.categories.standard_of_english.score}/10</span>
          </div>
          <div style="font-size: 9px; color: #666; line-height: 1.2;">${evaluation.categories.standard_of_english.feedback}</div>
        </div>
        
        <div style="margin-bottom: 8px; padding: 8px; background: #f8f9fa; border-radius: 4px; border-left: 2px solid #2c5aa0;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 600; font-size: 10px;">Problem Resolution</span>
            <span style="background: ${evaluation.categories.problem_resolution.score >= 8 ? '#10a54a' : '#2c5aa0'}; color: white; padding: 1px 4px; border-radius: 8px; font-size: 9px;">${evaluation.categories.problem_resolution.score}/10</span>
          </div>
          <div style="font-size: 9px; color: #666; line-height: 1.2;">${evaluation.categories.problem_resolution.feedback}</div>
        </div>
        
        <div style="margin-bottom: 8px; padding: 8px; background: #f8f9fa; border-radius: 4px; border-left: 2px solid #2c5aa0;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 600; font-size: 10px;">Following Structure</span>
            <span style="background: ${evaluation.categories.following_structure.score >= 8 ? '#10a54a' : '#2c5aa0'}; color: white; padding: 1px 4px; border-radius: 8px; font-size: 9px;">${evaluation.categories.following_structure.score}/10</span>
          </div>
          <div style="font-size: 9px; color: #666; line-height: 1.2;">${evaluation.categories.following_structure.feedback}</div>
        </div>
      </div>
      
      <div style="margin-bottom: 12px; padding: 8px; background: #fff9e6; border-radius: 4px; border-left: 2px solid #f0b90b;">
        <h4 style="font-size: 10px; margin: 0 0 6px 0;">🎯 Key Improvements</h4>
        <ul style="list-style: none; margin: 0; padding: 0;">
          ${evaluation.key_improvements.map(improvement => `
            <li style="font-size: 9px; color: #666; margin-bottom: 3px; padding-left: 8px; position: relative;">
              <span style="position: absolute; left: 0; color: #f0b90b;">•</span>
              ${improvement}
            </li>
          `).join('')}
        </ul>
      </div>
      
      <div style="text-align: center; color: #999; font-size: 9px; padding-top: 8px; border-top: 1px solid #e8e8e8;">
        Detected: ${productType}
      </div>
    </div>
  `;
}

// Test endpoint
app.get('/widget', (req, res) => {
  res.send(`
    <div style="padding: 20px; font-family: Arial, sans-serif;">
      <h3>📊 Response Evaluator</h3>
      <p>Final server with full evaluation! Help Scout calls POST /</p>
      <p>Time: ${new Date().toISOString()}</p>
    </div>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Final evaluation server running on 0.0.0.0:${PORT}`);
});
