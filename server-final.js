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
      console.log('Response preview:', latestResponse.text?.substring(0, 200) + '...');

      // Detect if this is about Shopify (app) or WordPress (plugin)
      console.log('Detecting Shopify context...');
      const isShopify = detectShopifyContext(conversation);
      console.log('Is Shopify:', isShopify);

      // For now, skip OpenAI and just show what we found
      const html = `
        <div style="padding: 20px; font-family: Arial, sans-serif; max-width: 300px;">
          <h3 style="color: #2c5aa0; font-size: 14px; margin: 0 0 16px 0;">📊 Response Evaluator</h3>
          
          <div style="background: #f0f8f0; padding: 12px; border-radius: 4px; margin-bottom: 12px;">
            <h4 style="margin: 0 0 8px 0; font-size: 12px;">✅ Team Response Found!</h4>
            <p style="margin: 4px 0; font-size: 11px;"><strong>Response length:</strong> ${latestResponse.text?.length || 0} characters</p>
            <p style="margin: 4px 0; font-size: 11px;"><strong>From:</strong> ${latestResponse.createdBy?.first || 'Unknown'} ${latestResponse.createdBy?.last || ''}</p>
            <p style="margin: 4px 0; font-size: 11px;"><strong>Context:</strong> ${isShopify ? 'Shopify App' : 'WordPress Plugin'}</p>
          </div>
          
          <div style="background: #f8f9fa; padding: 12px; border-radius: 4px; margin-bottom: 12px;">
            <h4 style="margin: 0 0 8px 0; font-size: 12px;">Response Preview:</h4>
            <p style="margin: 0; font-size: 10px; color: #666; line-height: 1.3; max-height: 100px; overflow-y: auto;">
              ${latestResponse.text?.substring(0, 300)}${latestResponse.text?.length > 300 ? '...' : ''}
            </p>
          </div>
          
          <div style="background: #fff9e6; padding: 12px; border-radius: 4px; border-left: 3px solid #f0b90b;">
            <h4 style="margin: 0 0 8px 0; font-size: 12px;">🎯 Next Step</h4>
            <p style="margin: 0; font-size: 11px;">Response content retrieved successfully. Ready to add OpenAI evaluation!</p>
          </div>
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
            createdBy: thread.createdBy?.type || thread.createdBy,
            createdByFull: thread.createdBy,
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
      // Check both createdBy formats (string and object)
      const isUser = thread.createdBy === 'user' || thread.createdBy?.type === 'user';

      console.log(`Checking thread: type=${thread.type}, isUser=${isUser}, hasBody=${!!thread.body}`);

      if (thread.type === 'message' && isUser && thread.body) {
        console.log('Found matching team response!');
        console.log('Response preview:', thread.body.substring(0, 200) + '...');
        console.log('Full response length:', thread.body.length);
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

  // Test endpoint
  app.get('/widget', (req, res) => {
    res.send(`
      <div style="padding: 20px; font-family: Arial, sans-serif;">
        <h3>📊 Response Evaluator</h3>
        <p>Testing response content retrieval! Help Scout calls POST /</p>
        <p>Time: ${new Date().toISOString()}</p>
      </div>
    `);
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Response content test server running on 0.0.0.0:${PORT}`);
  });
