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

// Helper function to escape HTML content safely
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
    console.log('Looking for latest team response...');
    const latestResponse = findLatestTeamResponse(conversation);
    
    if (!latestResponse) {
      console.log('No team response found');
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

    console.log('Found team response, length:', latestResponse.text?.length || 0);

    // Detect if this is about Shopify (app) or WordPress (plugin)
    console.log('Detecting Shopify context...');
    const isShopify = detectShopifyContext(conversation);
    console.log('Is Shopify:', isShopify);
    
    // Evaluate the response using OpenAI
    console.log('Starting OpenAI evaluation...');
    const evaluation = await evaluateResponse(latestResponse, conversation, isShopify);
    console.log('OpenAI evaluation completed');
    
    // Generate HTML with evaluation results
    const html = generateEvaluationHTML(evaluation, isShopify, ticket, customer);
    
    console.log('About to send response to Help Scout');
    console.log('Response structure:', { html: html ? 'HTML_PRESENT' : 'HTML_MISSING', length: html?.length || 0 });
    
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
    let accessToken = process.env.HELPSCOUT_ACCESS_TOKEN;
    
    if (!accessToken) {
      console.log('Attempting to get OAuth token...');
      const authResponse = await axios.post('https://api.helpscout.net/v2/oauth2/token', {
        grant_type: 'client_credentials',
        client_id: process.env.HELPSCOUT_APP_ID,
        client_secret: process.env.HELPSCOUT_APP_SECRET
      }, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      accessToken = authResponse.data.access_token;
    }

    console.log('Fetching conversation threads...');
    const threadsResponse = await axios.get(`https://api.helpscout.net/v2/conversations/${conversationId}/threads`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Number of threads:', threadsResponse.data._embedded?.threads?.length || 0);
    
    return {
      _embedded: { threads: threadsResponse.data._embedded?.threads || [] }
    };
    
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
    const isUser = thread.createdBy === 'user' || thread.createdBy?.type === 'user';
    
    if (thread.type === 'message' && isUser && thread.body) {
      console.log('Found team response from:', thread.createdBy?.first || 'Unknown');
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
  const allText = JSON.stringify(conversation).toLowerCase();
  return allText.includes('shopify') || allText.includes('shopify app');
}

// Evaluate response using OpenAI
async function evaluateResponse(response, conversation, isShopify) {
  const productType = isShopify ? 'app' : 'plugin';
  
  // Clean the response text by removing HTML tags
  const cleanText = response.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  
  const prompt = `You are evaluating a customer support response based on these guidelines:

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
"${cleanText}"

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
      "feedback": "Could use more natural phrasing in some areas"
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
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key is missing');
    }

    console.log('Making OpenAI API call...');
    const apiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are an expert at evaluating customer support responses. Always respond with valid JSON only, no other text.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 1500
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('OpenAI API call successful');
    const content = apiResponse.data.choices[0].message.content;
    return JSON.parse(content);
    
  } catch (error) {
    console.error('OpenAI API error:', error.response?.data || error.message);
    return {
      overall_score: 0,
      categories: {
        tone_empathy: { score: 0, feedback: "Unable to evaluate - API error" },
        clarity_completeness: { score: 0, feedback: "Unable to evaluate - API error" },
        standard_of_english: { score: 0, feedback: "Unable to evaluate - API error" },
        problem_resolution: { score: 0, feedback: "Unable to evaluate - API error" },
        following_structure: { score: 0, feedback: "Unable to evaluate - API error" }
      },
      key_improvements: ["OpenAI API error occurred - check logs for details"],
      error: error.response?.data?.error?.message || error.message
    };
  }
}

// Generate HTML for Help Scout sidebar
function generateEvaluationHTML(evaluation, isShopify, ticket, customer) {
  const productType = isShopify ? 'Shopify App' : 'WordPress Plugin';
  
  console.log('Generating HTML for evaluation');
  console.log('Evaluation data:', JSON.stringify(evaluation, null, 2));
  
  try {
    // Handle error cases
    if (evaluation.error) {
      return `
        <div style="font-family: Arial, sans-serif; font-size: 11px; padding: 16px; max-width: 300px;">
          <h3 style="color: #2c5aa0; font-size: 13px; margin: 0 0 12px 0;">📊 Response Evaluation</h3>
          <div style="background: #fff2f2; padding: 12px; border-radius: 4px; border-left: 3px solid #d63638;">
            <h4 style="margin: 0 0 8px 0; font-size: 12px; color: #d63638;">⚠️ Evaluation Error</h4>
            <p style="margin: 0; font-size: 11px;">${escapeHtml(evaluation.error)}</p>
            <p style="margin: 8px 0 0 0; font-size: 10px; color: #666;">Please check your OpenAI API key and try again.</p>
          </div>
          <div style="text-align: center; color: #999; font-size: 9px; padding-top: 8px; border-top: 1px solid #e8e8e8; margin-top: 12px;">
            Detected: ${productType}
          </div>
        </div>
      `;
    }

    const overallScore = Number(evaluation.overall_score) || 0;
    const scoreColor = overallScore >= 8 ? '#10a54a' : overallScore >= 6 ? '#2c5aa0' : '#d63638';
    
    const categories = evaluation.categories || {};
    
    // Generate improvements list separately to avoid template string issues
    console.log('Processing key improvements...');
    let improvementsHTML = '';
    const improvements = evaluation.key_improvements || [];
    console.log('Key improvements:', improvements);
    
    if (Array.isArray(improvements)) {
      for (let i = 0; i < improvements.length; i++) {
        const improvement = improvements[i];
        if (improvement && typeof improvement === 'string') {
          improvementsHTML += `
            <li style="font-size: 9px; color: #666; margin-bottom: 3px; padding-left: 8px; position: relative;">
              <span style="position: absolute; left: 0; color: #f0b90b;">•</span>
              ${escapeHtml(improvement)}
            </li>
          `;
        }
      }
    }
    console.log('Generated improvements HTML length:', improvementsHTML.length);
    
    const htmlResult = `
      <div style="font-family: Arial, sans-serif; font-size: 11px; padding: 16px; max-width: 300px;">
        <h3 style="color: #2c5aa0; font-size: 13px; margin: 0 0 12px 0;">📊 Response Evaluation</h3>
        
        <div style="display: flex; align-items: center; justify-content: center; margin-bottom: 16px; padding: 12px; background: #f8f9fa; border-radius: 6px;">
          <div style="display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 50%; background: ${scoreColor}; color: white; font-weight: bold; margin-right: 8px; font-size: 14px;">
            ${overallScore.toFixed(1)}
          </div>
          <div style="font-weight: 600; font-size: 11px;">Overall Score</div>
        </div>
        
        <div style="margin-bottom: 12px;">
          <div style="margin-bottom: 8px; padding: 8px; background: #f8f9fa; border-radius: 4px; border-left: 2px solid #2c5aa0;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span style="font-weight: 600; font-size: 10px;">Tone & Empathy</span>
              <span style="background: ${(categories.tone_empathy?.score || 0) >= 8 ? '#10a54a' : '#2c5aa0'}; color: white; padding: 1px 4px; border-radius: 8px; font-size: 9px;">${categories.tone_empathy?.score || 0}/10</span>
            </div>
            <div style="font-size: 9px; color: #666; line-height: 1.2;">${escapeHtml(categories.tone_empathy?.feedback || '')}</div>
          </div>
          
          <div style="margin-bottom: 8px; padding: 8px; background: #f8f9fa; border-radius: 4px; border-left: 2px solid #2c5aa0;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span style="font-weight: 600; font-size: 10px;">Clarity & Completeness</span>
              <span style="background: ${(categories.clarity_completeness?.score || 0) >= 8 ? '#10a54a' : '#2c5aa0'}; color: white; padding: 1px 4px; border-radius: 8px; font-size: 9px;">${categories.clarity_completeness?.score || 0}/10</span>
            </div>
            <div style="font-size: 9px; color: #666; line-height: 1.2;">${escapeHtml(categories.clarity_completeness?.feedback || '')}</div>
          </div>
          
          <div style="margin-bottom: 8px; padding: 8px; background: #f8f9fa; border-radius: 4px; border-left: 2px solid #2c5aa0;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span style="font-weight: 600; font-size: 10px;">Standard of English</span>
              <span style="background: ${(categories.standard_of_english?.score || 0) >= 8 ? '#10a54a' : '#2c5aa0'}; color: white; padding: 1px 4px; border-radius: 8px; font-size: 9px;">${categories.standard_of_english?.score || 0}/10</span>
            </div>
            <div style="font-size: 9px; color: #666; line-height: 1.2;">${escapeHtml(categories.standard_of_english?.feedback || '')}</div>
          </div>
          
          <div style="margin-bottom: 8px; padding: 8px; background: #f8f9fa; border-radius: 4px; border-left: 2px solid #2c5aa0;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span style="font-weight: 600; font-size: 10px;">Problem Resolution</span>
              <span style="background: ${(categories.problem_resolution?.score || 0) >= 8 ? '#10a54a' : '#2c5aa0'}; color: white; padding: 1px 4px; border-radius: 8px; font-size: 9px;">${categories.problem_resolution?.score || 0}/10</span>
            </div>
            <div style="font-size: 9px; color: #666; line-height: 1.2;">${escapeHtml(categories.problem_resolution?.feedback || '')}</div>
          </div>
          
          <div style="margin-bottom: 8px; padding: 8px; background: #f8f9fa; border-radius: 4px; border-left: 2px solid #2c5aa0;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span style="font-weight: 600; font-size: 10px;">Following Structure</span>
              <span style="background: ${(categories.following_structure?.score || 0) >= 8 ? '#10a54a' : '#2c5aa0'}; color: white; padding: 1px 4px; border-radius: 8px; font-size: 9px;">${categories.following_structure?.score || 0}/10</span>
            </div>
            <div style="font-size: 9px; color: #666; line-height: 1.2;">${escapeHtml(categories.following_structure?.feedback || '')}</div>
          </div>
        </div>
        
        <div style="margin-bottom: 12px; padding: 8px; background: #fff9e6; border-radius: 4px; border-left: 2px solid #f0b90b;">
          <h4 style="font-size: 10px; margin: 0 0 6px 0;">🎯 Key Improvements</h4>
          <ul style="list-style: none; margin: 0; padding: 0;">
            ${improvementsHTML}
          </ul>
        </div>
        
        <div style="text-align: center; color: #999; font-size: 9px; padding-top: 8px; border-top: 1px solid #e8e8e8;">
          Detected: ${productType}
        </div>
      </div>
    `;
    
    console.log('Generated HTML successfully, length:', htmlResult.length);
    console.log('Returning HTML to Help Scout...');
    return htmlResult;
    
  } catch (error) {
    console.error('Error generating HTML:', error);
    console.error('Error stack:', error.stack);
    return `
      <div style="padding: 20px; font-family: Arial, sans-serif;">
        <h3>📊 Response Evaluator</h3>
        <p style="color: red;">HTML generation error: ${error.message}</p>
        <p style="font-size: 10px;">Check logs for details</p>
      </div>
    `;
  }
}

// Test endpoint
app.get('/widget', (req, res) => {
  res.send(`
    <div style="padding: 20px; font-family: Arial, sans-serif;">
      <h3>📊 Response Evaluator</h3>
      <p>Complete evaluation server with OpenAI!</p>
      <p>Time: ${new Date().toISOString()}</p>
    </div>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Complete evaluation server running on 0.0.0.0:${PORT}`);
});
