const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path'); // Import the path module
const { GoogleGenerativeAI } = require("@google/generative-ai");

// This line loads the variables from your .env file into process.env
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini AI Client and specify the flash model to be used for all tasks
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Use CORS for the API route
app.use('/api', cors());

// A simple in-memory cache to avoid hitting API rate limits
const cache = new Map();

// --- AI-Powered Functions ---
async function getAIRecommendations(budget, currency) {
    let convertedBudgetUSD = budget;
    let budgetContext = `The user's budget is ${budget} ${currency}.`;

    if (currency !== 'USD') {
        try {
            const exchangeResponse = await axios.get(`https://api.frankfurter.app/latest?from=${currency}&to=USD`);
            const rate = exchangeResponse.data.rates.USD;
            convertedBudgetUSD = budget * rate;
            budgetContext = `The user's budget is ${budget} ${currency}, which is approximately ${Math.round(convertedBudgetUSD)} USD.`;
        } catch (error) {
            console.error(`Failed to fetch exchange rate for ${currency}.`, error.message);
        }
    }

    const prompt = `You are a highly realistic and practical travel expert. A user has a budget for a one-week trip. ${budgetContext}
Your task is to suggest 5 travel destinations based on the following strict rules:

1.  If the budget is extremely low and not feasible for any international travel (e.g., under 15000 INR or 200 USD), you MUST suggest 5 famous travel CITIES within that currency's home country.
2.  If the budget is moderate (e.g., between 200 USD and 700 USD), suggest 5 budget-friendly CITIES, each from a different nearby or affordable country.
3.  If the budget is high (e.g., over 700 USD), suggest 5 diverse COUNTRIES suitable for that budget.

IMPORTANT: For rules 2 and 3, ensure all 5 suggestions are from different countries.

Provide your answer ONLY as a valid JSON array of objects. Each object must have a "name" and a "type" ('city' or 'country'). For cities, you MUST also include the "country" name.
Do not add any other text, markdown, or explanations.`;

    try {
        console.log("Asking Gemini for realistic and diverse travel locations...");
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        if (typeof text !== 'string') {
            throw new Error("Received a non-text response from the AI model.");
        }

        const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const locationList = JSON.parse(cleanedText);
        console.log("Gemini suggested locations:", locationList);
        return locationList;
    } catch (error) {
        console.error("Error calling Gemini API for locations:", error);
        return [];
    }
}

async function getSightsFromAI(locationName) {
    const prompt = `Suggest the 3 most famous tourist attractions in ${locationName}. Provide your answer ONLY as a valid JSON array of strings. Example: ["Eiffel Tower", "Louvre Museum", "Notre-Dame Cathedral"]. Do not add any other text.`;
    
    try {
        console.log(`Asking Gemini for sights in ${locationName}...`);
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        if (typeof text !== 'string') {
            throw new Error("Received a non-text response from the AI model for sights.");
        }

        const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const sights = JSON.parse(cleanedText);
        return sights;
    } catch (error) {
        console.error(`Error calling Gemini API for sights in ${locationName}:`, error);
        return ["Famous landmarks", "Local markets", "Beautiful parks"];
    }
}

// --- API Route ---
app.get('/api/destinations', async (req, res) => {
    const budget = parseInt(req.query.budget, 10);
    const currency = req.query.currency || 'USD';

    if (isNaN(budget)) {
        return res.status(400).json({ error: 'A valid budget parameter is required.' });
    }

    const cacheKey = `destinations-v5-${budget}-${currency}`;
    if (cache.has(cacheKey) && (Date.now() - cache.get(cacheKey).timestamp < 3600000)) {
        console.log(`Serving from cache for ${budget} ${currency}`);
        return res.json(cache.get(cacheKey).data);
    }

    console.log(`Fetching new AI suggestions for budget ${budget} ${currency}`);

    try {
        const suggestedLocations = await getAIRecommendations(budget, currency);
        if (!suggestedLocations || suggestedLocations.length === 0) {
            throw new Error("AI did not return any location suggestions.");
        }

        const destinations = [];
        for (const location of suggestedLocations) {
            try {
                // Added a 10-second timeout to each API call to prevent getting stuck
                const timeout = 10000;
                const isCity = location.type === 'city';
                const countryName = isCity ? location.country : location.name;
                const locationName = location.name;

                const countryResponse = await axios.get(`https://restcountries.com/v3.1/name/${countryName.trim()}?fullText=true`, { timeout });
                const country = countryResponse.data[0];
                if (!country) continue;

                let latlng, displayName, subtext;

                if (isCity) {
                    const geocodeResponse = await axios.get(`https://api.openweathermap.org/geo/1.0/direct`, {
                        params: { q: `${locationName},${country.cca2}`, limit: 1, appid: process.env.OPENWEATHER_API_KEY },
                        timeout
                    });
                    if (geocodeResponse.data && geocodeResponse.data.length > 0) {
                        latlng = [geocodeResponse.data[0].lat, geocodeResponse.data[0].lon];
                    } else { continue; }
                    displayName = locationName;
                    subtext = country.name.common;
                } else {
                    if (!country.capital || !country.capitalInfo.latlng) continue;
                    latlng = country.capitalInfo.latlng;
                    displayName = country.capital[0];
                    subtext = country.capital[0];
                }

                const weatherPromise = axios.get(`https://api.openweathermap.org/data/2.5/weather`, {
                    params: { q: displayName, appid: process.env.OPENWEATHER_API_KEY, units: 'metric' },
                    timeout
                });
                
                const attractionsPromise = getSightsFromAI(locationName);

                const [weatherResponse, attractions] = await Promise.all([weatherPromise, attractionsPromise]);
                
                destinations.push({
                    name: locationName,
                    capital: subtext,
                    flag: country.flags.svg,
                    currency: Object.values(country.currencies)[0].name,
                    latlng: latlng,
                    weather: {
                        temp: weatherResponse.data.main.temp,
                        description: weatherResponse.data.weather[0].description
                    },
                    attractions: attractions,
                });

            } catch (error) {
                console.error(`Failed to fetch full data for ${location.name}:`, error.message);
            }
        }
        
        cache.set(cacheKey, { timestamp: Date.now(), data: destinations });
        res.json(destinations);

    } catch (error) {
        console.error("Major error in API orchestration:", error.message);
        res.status(500).json({ error: 'Failed to fetch external API data. Check server logs and API keys.' });
    }
});


// --- Serve Frontend ---
// This part is crucial for fixing the "Cannot GET /" error
const frontendDirPath = path.join(__dirname, '..', 'FRONTEND');
app.use(express.static(frontendDirPath));

app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDirPath, 'index.html'));
});


// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY) {
        console.warn("\x1b[33m%s\x1b[0m", "Warning: GEMINI_API_KEY is missing from .env file.");
    }
    if (!process.env.OPENWEATHER_API_KEY) {
        console.warn("\x1b[33m%s\x1b[0m", "Warning: OPENWEATHER_API_KEY is missing.");
    }
});

