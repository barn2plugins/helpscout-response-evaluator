const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Help Scout dynamic app endpoint
app.post('/', async (req, res) => {
  try {
    console.log('=== Help Scout Request ===');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Query:', JSON.stringify(req.query, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    // Return HTML that uses Help Scout's JavaScript SDK to get conversation data
    const html = `
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
              .loading {
                  text-align: center;
                  padding: 20px 0;
              }
              .spinner {
                  width: 24px;
                  height: 24px;
                  border: 2px solid #e8e8e8;
                  border-top: 2px solid #2c5aa0;
                  border-radius: 50%;
                  animation: spin 1s linear infinite;
                  margin: 0 auto 12px;
              }
              @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
              }
              .error {
                  color: #d63638;
                  background: #fff2f2;
                  padding: 12px;
                  border-radius: 4px;
                  margin: 12px 0;
              }
              .success {
                  background: #f0f8f0;
                  padding: 12px;
                  border-radius: 4px;
                  margin: 12px 0;
              }
          </style>
      </head>
      <body>
          <div class="header">
              <h3>📊 Response Evaluator</h3>
          </div>
          
          <div id="loading" class="loading">
              <div class="spinner"></div>
              <p>Loading conversation data...</p>
          </div>
          
          <div id="content"></div>

          <script>
              // Help Scout provides context data through parent window
              function getHelpScoutData() {
                  try {
                      // Try to get data from parent window (Help Scout)
                      if (window.parent && window.parent !== window) {
                          const urlParams = new URLSearchParams(window.parent.location.search);
                          const conversationMatch = window.parent.location.pathname.match(/\\/conversation\\/(\\d+)/);
                          
                          return {
                              conversationId: conversationMatch ? conversationMatch[1] : null,
                              customerEmail: urlParams.get('customer_email'),
                              ticketNumber: urlParams.get('number'),
                              hasParentContext: true,
                              parentUrl: window.parent.location.href
                          };
                      }
                      return { hasParentContext: false };
                  } catch (error) {
                      return { 
                          hasParentContext: false, 
                          error: error.message 
                      };
                  }
              }

              function displayResults(data) {
                  const loading = document.getElementById('loading');
                  const content = document.getElementById('content');
                  
                  loading.style.display = 'none';
                  
                  if (data.conversationId) {
                      content.innerHTML = \`
                          <div class="success">
                              <h4>✅ Connected Successfully!</h4>
                              <p><strong>Conversation ID:</strong> \${data.conversationId}</p>
                              <p><strong>Customer Email:</strong> \${data.customerEmail || 'Not available'}</p>
                              <p><strong>Ticket Number:</strong> \${data.ticketNumber || 'Not available'}</p>
                              <p><strong>Parent URL:</strong> \${data.parentUrl}</p>
                              <hr>
                              <p><em>Next: Add OpenAI evaluation...</em></p>
                          </div>
                      \`;
                  } else {
                      content.innerHTML = \`
                          <div class="error">
                              <h4>🔍 Debug Information</h4>
                              <p><strong>Has Parent Context:</strong> \${data.hasParentContext}</p>
                              <p><strong>Error:</strong> \${data.error || 'None'}</p>
                              <p><strong>Window Location:</strong> \${window.location.href}</p>
                              <p><strong>Parent Location:</strong> \${data.parentUrl || 'Not accessible'}</p>
                              <hr>
                              <p><em>Investigating Help Scout data access...</em></p>
                          </div>
                      \`;
                  }
              }

              // Initialize when page loads
              document.addEventListener('DOMContentLoaded', function() {
                  setTimeout(() => {
                      const data = getHelpScoutData();
                      displayResults(data);
                  }, 1000);
              });
          </script>
      </body>
      </html>
    `;
    
    res.send(html);

  } catch (error) {
    console.error('Error:', error);
    res.send(`
      <div style="padding: 20px; font-family: Arial, sans-serif;">
        <h3>📊 Response Evaluator</h3>
        <p style="color: red;">Error: ${error.message}</p>
      </div>
    `);
  }
});

// Test endpoint
app.get('/widget', (req, res) => {
  res.send(`
    <div style="padding: 20px; font-family: Arial, sans-serif;">
      <h3>📊 Response Evaluator</h3>
      <p>Server is running! Help Scout calls POST /</p>
      <p>Time: ${new Date().toISOString()}</p>
    </div>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Working server running on 0.0.0.0:${PORT}`);
});