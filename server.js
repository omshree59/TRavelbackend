const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path'); // Import the 'path' module
const { GoogleGenerativeAI } = require("@google/generative-ai");

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.use(cors());
const cache = new Map();

// --- Static File Serving ---
// This tells Express to serve your index.html and any other static files
// from the 'public' directory. This is crucial for deployment.
app.use(express.static(path.join(__dirname, 'public')));
// --------------------------


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
    const prompt = `You are a highly realistic travel expert. A user has a budget for a one-week trip. ${budgetContext}
Based on these strict rules, suggest 5 travel destinations:
1. If the budget is extremely low (under 200 USD), you MUST suggest 5 famous travel CITIES within that currency's home country.
2. If the budget is moderate (between 200 USD and 700 USD), suggest 5 budget-friendly CITIES, each from a different nearby or affordable country.
3. If the budget is high (over 700 USD), suggest 5 diverse COUNTRIES.
IMPORTANT: For rules 2 and 3, ensure all 5 suggestions are from different countries.
Provide your answer ONLY as a valid JSON array of objects. Each object must have a "name" and a "type" ('city' or 'country'). For cities, you MUST also include "country".
Do not add any other text.`;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        if (typeof text !== 'string') throw new Error("Received a non-text response from AI.");
        const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanedText);
    } catch (error) {
        console.error("Error calling Gemini API for locations:", error);
        return [];
    }
}

async function getSightsFromAI(locationName) {
    const prompt = `Suggest the 3 most famous tourist attractions in ${locationName}. Provide your answer ONLY as a valid JSON array of strings. Example: ["Eiffel Tower", "Louvre Museum"]. Do not add any other text.`;
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        if (typeof text !== 'string') throw new Error("Received a non-text response from AI for sights.");
        const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanedText);
    } catch (error) {
        console.error(`Error calling Gemini API for sights in ${locationName}:`, error);
        return ["Famous landmarks", "Local markets"];
    }
}

// --- API Route ---
app.get('/api/destinations', async (req, res) => {
    const budget = parseInt(req.query.budget, 10);
    const currency = req.query.currency || 'USD';

    if (isNaN(budget)) {
        return res.status(400).json({ error: 'A valid budget is required.' });
    }

    const cacheKey = `destinations-v6-${budget}-${currency}`;
    if (cache.has(cacheKey) && (Date.now() - cache.get(cacheKey).timestamp < 3600000)) {
        console.log(`Serving from cache for ${budget} ${currency}`);
        return res.json(cache.get(cacheKey).data);
    }

    try {
        const suggestedLocations = await getAIRecommendations(budget, currency);
        if (!suggestedLocations || suggestedLocations.length === 0) {
            throw new Error("AI did not return any suggestions.");
        }

        const destinations = [];
        for (const location of suggestedLocations) {
            try {
                const isCity = location.type === 'city';
                const countryName = isCity ? location.country : location.name;
                const locationName = location.name;

                const countryPromise = axios.get(`https://restcountries.com/v3.1/name/${countryName.trim()}?fullText=true`, { timeout: 10000 });
                const countryResponse = await countryPromise;
                const country = countryResponse.data[0];
                if (!country) continue;

                let latlng, displayName, subtext;
                if (isCity) {
                    const geocodePromise = axios.get(`https://api.openweathermap.org/geo/1.0/direct`, {
                        params: { q: `${locationName},${country.cca2}`, limit: 1, appid: process.env.OPENWEATHER_API_KEY },
                        timeout: 10000
                    });
                    const geocodeResponse = await geocodePromise;
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
                    timeout: 10000
                });
                const attractionsPromise = getSightsFromAI(locationName);
                const [weatherResponse, attractions] = await Promise.all([weatherPromise, attractionsPromise]);

                // Added a safety check for currency data to prevent crashes
                const currencyData = country.currencies ? Object.values(country.currencies)[0] : null;

                destinations.push({
                    name: locationName,
                    capital: subtext,
                    flag: country.flags.svg,
                    currency: currencyData ? currencyData.name : 'N/A',
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
        console.error("Major error in API orchestration:", error);
        res.status(500).json({ error: 'Failed to fetch API data.' });
    }
});

// --- Catch-all Route for Frontend ---
// This makes sure that any request that isn't for the API gets the index.html file.
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

