const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Simple in-memory cache for evaluations
const evaluationCache = new Map();

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

    // Check if this is a live chat - don't show widget for chats
    // Help Scout generates subjects like "Live chat on Aug 5" for chat conversations
    const isChatConversation = 
      ticket.type === 'chat' || 
      ticket.source?.type === 'chat' || 
      ticket.source?.type === 'beacon' ||
      (typeof ticket.type === 'string' && ticket.type.toLowerCase() === 'chat') ||
      (typeof ticket.source?.type === 'string' && ['chat', 'beacon'].includes(ticket.source.type.toLowerCase())) ||
      (ticket.subject && ticket.subject.startsWith('Live chat on '));

    if (isChatConversation) {
      console.log('Skipping evaluation for live chat conversation');
      return res.json({
        html: ''  // Return empty HTML to hide widget
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

    // Create cache key from response text
    const cacheKey = `${ticket.id}_${latestResponse.createdAt}`;
    
    // Check if we already have results
    if (evaluationCache.has(cacheKey)) {
      console.log('Returning cached evaluation results');
      const evaluation = evaluationCache.get(cacheKey);
      
      // Build detailed results HTML
      let categoriesHTML = '';
      if (evaluation.categories) {
        const cats = evaluation.categories;
        if (cats.tone_empathy) categoriesHTML += `<p style="font-size: 11px; margin: 4px 0;"><strong>Tone & Empathy:</strong> ${cats.tone_empathy.score}/10 - ${cats.tone_empathy.feedback}</p>`;
        if (cats.clarity_completeness) categoriesHTML += `<p style="font-size: 11px; margin: 4px 0;"><strong>Clarity:</strong> ${cats.clarity_completeness.score}/10 - ${cats.clarity_completeness.feedback}</p>`;
        if (cats.standard_of_english) categoriesHTML += `<p style="font-size: 11px; margin: 4px 0;"><strong>English:</strong> ${cats.standard_of_english.score}/10 - ${cats.standard_of_english.feedback}</p>`;
        if (cats.problem_resolution) categoriesHTML += `<p style="font-size: 11px; margin: 4px 0;"><strong>Problem Resolution:</strong> ${cats.problem_resolution.score}/10 - ${cats.problem_resolution.feedback}</p>`;
      }
      
      let improvementsHTML = '';
      if (evaluation.key_improvements && evaluation.key_improvements.length > 0) {
        improvementsHTML = '<div style="margin-top: 12px; padding: 8px; background: #fff9e6; border-radius: 4px;"><strong style="font-size: 11px;">Key Improvements: </strong><ul style="margin: 4px 0; padding-left: 16px;">';
        evaluation.key_improvements.forEach(improvement => {
          improvementsHTML += `<li style="font-size: 10px; margin: 2px 0;">${improvement}</li>`;
        });
        improvementsHTML += '</ul></div>';
      } else {
        improvementsHTML = '<div style="margin-top: 12px; padding: 8px; background: #f0f8f0; border-radius: 4px;"><strong style="font-size: 11px;">Key Improvements: </strong><span style="font-size: 10px;">No recommendations - excellent response!</span></div>';
      }
      
      const html = `
        <div style="font-family: Arial, sans-serif; padding: 16px; max-width: 350px;">
          <h3 style="margin: 0 0 12px 0;">📊 Response Evaluation</h3>
          <div style="text-align: center; padding: 8px; background: #f0f8f0; border-radius: 4px; margin-bottom: 12px;">
            <strong style="font-size: 16px;">Overall Score: ${evaluation.overall_score}/10</strong>
          </div>
          ${categoriesHTML}
          ${improvementsHTML}
        </div>
      `;
      
      return res.json({ html });
    }
    
    // Start OpenAI evaluation in background
    console.log('Starting background OpenAI evaluation...');
    
    evaluateResponse(latestResponse, conversation)
      .then(evaluation => {
        console.log('Background evaluation completed:', evaluation.overall_score);
        evaluationCache.set(cacheKey, evaluation);
      })
      .catch(error => {
        console.error('Background evaluation failed:', error.message);
        evaluationCache.set(cacheKey, { overall_score: 0, error: error.message });
      });
    
    // Return processing message with auto-refresh JavaScript
    const html = `
      <div style="font-family: Arial, sans-serif; padding: 16px;" id="evaluation-widget">
        <h3>📊 Response Evaluation</h3>
        <div style="text-align: center; padding: 12px; background: #f0f8ff; border-radius: 4px;">
          <p style="margin: 4px 0;"><strong>Status:</strong> Processing with OpenAI...</p>
          <p style="font-size: 10px; color: #666; margin: 4px 0;" id="status-message">Evaluating response, please wait...</p>
        </div>
        <script>
          (function() {
            let attempts = 0;
            const maxAttempts = 20; // Try for ~2 minutes (6s intervals)
            
            function checkForResults() {
              attempts++;
              
              if (attempts > maxAttempts) {
                document.getElementById('status-message').innerHTML = 'Evaluation taking longer than expected. <a href="#" onclick="location.reload(); return false;">Click to refresh</a>';
                return;
              }
              
              fetch(window.location.href, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(${JSON.stringify(req.body)})
              })
              .then(response => response.json())
              .then(data => {
                if (data.html && !data.html.includes('Processing with OpenAI')) {
                  document.getElementById('evaluation-widget').innerHTML = data.html;
                } else {
                  document.getElementById('status-message').textContent = 'Still processing... (' + (attempts * 6) + 's)';
                  setTimeout(checkForResults, 6000);
                }
              })
              .catch(error => {
                console.error('Error checking results:', error);
                setTimeout(checkForResults, 6000);
              });
            }
            
            // Start polling after 10 seconds
            setTimeout(checkForResults, 10000);
          })();
        </script>
      </div>
    `;
    
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


// Evaluate response using OpenAI
async function evaluateResponse(response, conversation) {
  
  // Clean the response text by removing HTML tags
  const cleanText = response.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  
  const prompt = `You are evaluating a customer support response based on these guidelines:

SUPPORT TONE REQUIREMENTS:
1. MUST start by thanking the customer
2. MUST end with a polite closing - acceptable closings include: "Let me know if you have any questions", "Please let me know what happens", "Best regards", "Many thanks", "Kind regards", or similar polite phrases
3. Should suggest workarounds ONLY when saying something isn't possible (not when providing complete solutions)
4. Only apologize when the company has done something wrong
5. Use positive language (avoid "but" and "however")
6. Include relevant links ONLY when specifically mentioning documentation, help articles, or specific features that would benefit from a direct link
7. Focus on being helpful and reassuring, especially for pre-sales

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

IMPORTANT FOR KEY IMPROVEMENTS:
- Only suggest improvements that are actually needed
- If the response already does something well (like good English or proper closing), don't suggest "continuing" it
- If no meaningful improvements are needed, return an empty array
- Workarounds should only be suggested for negative responses where something isn't possible
- Only suggest adding links if the response mentions specific features/documentation but lacks helpful links
- Each improvement should be a specific, actionable suggestion

Then provide an overall score out of 10 and specific suggestions for improvement.

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
    "Add a link to the relevant documentation"
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
  console.log('Starting HTML generation process...');
  
  try {
    console.log('Checking for evaluation errors...');
    // Handle error cases
    if (evaluation.error) {
      console.log('Found evaluation error, returning error HTML');
      return '<div style="font-family: Arial, sans-serif; padding: 16px;"><h3>📊 Response Evaluation</h3><p style="color: red;">Evaluation Error: ' + escapeHtml(evaluation.error) + '</p></div>';
    }

    console.log('Processing evaluation scores...');
    const overallScore = Number(evaluation.overall_score) || 0;
    const scoreColor = overallScore >= 8 ? '#10a54a' : overallScore >= 6 ? '#2c5aa0' : '#d63638';
    
    const categories = evaluation.categories || {};
    console.log('Categories processed');
    
    // Simple approach - build HTML piece by piece
    console.log('Building HTML components...');
    
    let html = '<div style="font-family: Arial, sans-serif; font-size: 11px; padding: 16px; max-width: 300px;">';
    html += '<h3 style="color: #2c5aa0; font-size: 13px; margin: 0 0 12px 0;">📊 Response Evaluation</h3>';
    
    // Overall score section
    html += '<div style="display: flex; align-items: center; justify-content: center; margin-bottom: 16px; padding: 12px; background: #f8f9fa; border-radius: 6px;">';
    html += '<div style="display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 50%; background: ' + scoreColor + '; color: white; font-weight: bold; margin-right: 8px; font-size: 14px;">';
    html += overallScore.toFixed(1);
    html += '</div>';
    html += '<div style="font-weight: 600; font-size: 11px;">Overall Score</div>';
    html += '</div>';
    
    console.log('Overall score section built');
    
    // Categories - build each one safely
    html += '<div style="margin-bottom: 12px;">';
    
    // Just show a simple summary instead of detailed breakdown
    html += '<div style="padding: 8px; background: #f8f9fa; border-radius: 4px; text-align: center;">';
    html += '<p style="margin: 4px 0; font-size: 10px;">Evaluation completed successfully!</p>';
    html += '<p style="margin: 4px 0; font-size: 9px;">Overall Score: ' + overallScore.toFixed(1) + '/10</p>';
    html += '</div>';
    
    html += '</div>';
    
    // Footer
    html += '<div style="text-align: center; color: #999; font-size: 9px; padding-top: 8px; border-top: 1px solid #e8e8e8;">';
    html += 'Detected: ' + productType;
    html += '</div>';
    
    html += '</div>';
    
    console.log('HTML generation completed successfully, length:', html.length);
    return html;
    
  } catch (error) {
    console.error('Error generating HTML:', error);
    console.error('Error stack:', error.stack);
    return '<div style="padding: 20px; font-family: Arial, sans-serif;"><h3>📊 Response Evaluator</h3><p style="color: red;">HTML generation error: ' + error.message + '</p></div>';
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
  console.log(`UPDATED evaluation server running on 0.0.0.0:${PORT}`);
});
