// Help Scout Dynamic App JavaScript
(function() {
    // Get conversation data from Help Scout
    function getConversationData() {
        // This will be provided by Help Scout's Dynamic App context
        if (window.parent && window.parent.HS && window.parent.HS.conversation) {
            return {
                conversationId: window.parent.HS.conversation.id,
                customerId: window.parent.HS.conversation.customer?.id
            };
        }
        
        // Fallback: try to extract from URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        return {
            conversationId: urlParams.get('conversation') || urlParams.get('conversationId'),
            customerId: urlParams.get('customer') || urlParams.get('customerId')
        };
    }

    // Format score with color coding
    function formatScore(score) {
        let className = 'score-poor';
        if (score >= 9) className = 'score-excellent';
        else if (score >= 7) className = 'score-good';
        else if (score >= 5) className = 'score-fair';
        
        return { score: score.toFixed(1), className };
    }

    // Display evaluation results
    function displayResults(data) {
        const loadingEl = document.getElementById('loading');
        const resultsEl = document.getElementById('evaluation-results');
        const noResponseEl = document.getElementById('no-response');
        
        loadingEl.style.display = 'none';
        
        if (!data.hasResponse) {
            noResponseEl.style.display = 'block';
            return;
        }
        
        const evaluation = data.evaluation;
        
        // Overall score
        const overallFormatted = formatScore(evaluation.overall_score);
        document.getElementById('overall-score').textContent = overallFormatted.score;
        document.querySelector('.score-circle').className = `score-circle ${overallFormatted.className}`;
        
        // Category scores
        const categories = evaluation.categories;
        
        // Tone & Empathy
        const toneFormatted = formatScore(categories.tone_empathy.score);
        document.getElementById('tone-score').textContent = toneFormatted.score;
        document.getElementById('tone-score').className = `category-score ${toneFormatted.className}`;
        document.getElementById('tone-feedback').textContent = categories.tone_empathy.feedback;
        
        // Clarity & Completeness
        const clarityFormatted = formatScore(categories.clarity_completeness.score);
        document.getElementById('clarity-score').textContent = clarityFormatted.score;
        document.getElementById('clarity-score').className = `category-score ${clarityFormatted.className}`;
        document.getElementById('clarity-feedback').textContent = categories.clarity_completeness.feedback;
        
        // Standard of English
        const englishFormatted = formatScore(categories.standard_of_english.score);
        document.getElementById('english-score').textContent = englishFormatted.score;
        document.getElementById('english-score').className = `category-score ${englishFormatted.className}`;
        document.getElementById('english-feedback').textContent = categories.standard_of_english.feedback;
        
        // Problem Resolution
        const resolutionFormatted = formatScore(categories.problem_resolution.score);
        document.getElementById('resolution-score').textContent = resolutionFormatted.score;
        document.getElementById('resolution-score').className = `category-score ${resolutionFormatted.className}`;
        document.getElementById('resolution-feedback').textContent = categories.problem_resolution.feedback;
        
        // Following Structure
        const structureFormatted = formatScore(categories.following_structure.score);
        document.getElementById('structure-score').textContent = structureFormatted.score;
        document.getElementById('structure-score').className = `category-score ${structureFormatted.className}`;
        document.getElementById('structure-feedback').textContent = categories.following_structure.feedback;
        
        // Key improvements
        const improvementsList = document.getElementById('improvements-list');
        improvementsList.innerHTML = '';
        evaluation.key_improvements.forEach(improvement => {
            const li = document.createElement('li');
            li.textContent = improvement;
            improvementsList.appendChild(li);
        });
        
        // Product type indicator
        if (data.isShopify !== undefined) {
            document.getElementById('product-type').style.display = 'block';
            document.getElementById('product-type-text').textContent = 
                data.isShopify ? 'Shopify App' : 'WordPress Plugin';
        }
        
        resultsEl.style.display = 'block';
    }

    // Display error
    function displayError(message) {
        document.getElementById('loading').style.display = 'none';
        const errorEl = document.getElementById('error');
        errorEl.querySelector('p').textContent = message || 'Error loading evaluation. Please try refreshing.';
        errorEl.style.display = 'block';
    }

    // Make API request to evaluate response
    async function evaluateResponse() {
        try {
            const conversationData = getConversationData();
            
            if (!conversationData.conversationId) {
                displayError('No conversation ID found');
                return;
            }

            const response = await fetch('/api/evaluate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(conversationData)
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            displayResults(data);

        } catch (error) {
            console.error('Error evaluating response:', error);
            displayError(error.message);
        }
    }

    // Initialize when page loads
    document.addEventListener('DOMContentLoaded', function() {
        // Small delay to ensure Help Scout context is available
        setTimeout(evaluateResponse, 500);
    });

    // Also try to initialize immediately in case DOMContentLoaded already fired
    if (document.readyState === 'loading') {
        // Document still loading, wait for DOMContentLoaded
    } else {
        // Document already loaded
        setTimeout(evaluateResponse, 500);
    }
})();