/**
 * main.js - Weather System Entry Point
 * 
 * This script does THREE things only:
 * 1. Fetches real-time weather from API
 * 2. Decides which weather mode to use (via classifyCategory from weatherapi.js)
 * 3. Dynamically imports the corresponding weather visualization
 * 
 * The weather scripts (sunny.js, rainy.js, etc.) are SELF-CONTAINED.
 * They create their own Three.js scene/renderer and run automatically on import.
 */

import { fetchRealtimeWeather, classifyCategory } from './weatherapi.js';

// =============================================================================
// CONFIGURATION - Adjust these as needed
// =============================================================================

// Default location fallback (New York City)
const DEFAULT_LAT = 40.7128;
const DEFAULT_LON = -74.0060;

// =============================================================================
// 1. FETCH REAL-TIME WEATHER
// =============================================================================

/**
 * Fetches current weather data using the existing fetchRealtimeWeather from weatherapi.js.
 * Uses geolocation if available, falls back to default location.
 */
async function fetchWeather() {
    try {
        let query = "auto:ip"; // Default: use IP-based location

        // Try geolocation for more accurate location
        if ("geolocation" in navigator) {
            try {
                const pos = await new Promise((resolve, reject) => {
                    navigator.geolocation.getCurrentPosition(resolve, reject, {
                        timeout: 5000,
                        enableHighAccuracy: false
                    });
                });
                query = `${pos.coords.latitude},${pos.coords.longitude}`;
                console.log(`📍 Geolocation: ${query}`);
            } catch (e) {
                console.warn("⚠️ Geolocation denied/failed, using IP-based location");
            }
        }

        // Use the existing fetchRealtimeWeather from weatherapi.js
        const data = await fetchRealtimeWeather(query);
        console.log("🌤️ Weather API response:", data);

        return data;

    } catch (error) {
        console.error("❌ Weather fetch failed:", error);
        return null;
    }
}

// =============================================================================
// 2. DECIDE WEATHER MODE
// =============================================================================

/**
 * Maps API weather data to a visualization mode using classifyCategory from weatherapi.js.
 * 
 * The classification is based on the condition CODE from the API, which maps to:
 * - "SNOW" → snowy.js
 * - "RAIN" → rainy.js  
 * - "CLOUDY" → cloudy.js
 * - "SUNNY" → sunny.js
 * - "WINDY" → currently falls back to cloudy.js (no windy.js exists)
 * 
 * The mapping logic is defined in weatherapi.js → buildCodeCategoryMap()
 */
async function decideModeFromWeather(weatherData) {
    if (!weatherData) {
        console.log("⚠️ No weather data, defaulting to CLOUDY");
        return 'cloudy';
    }

    try {
        // Use the existing classification from weatherapi.js
        const { category, code, text } = await classifyCategory(weatherData);
        
        console.log(`🏷️ Condition: "${text}" (code: ${code}) → Category: ${category}`);

        // Map category to module name
        switch (category) {
            case 'SNOW':
                console.log("❄️ Mode: SNOWY");
                return 'snowy';
            
            case 'RAIN':
                console.log("🌧️ Mode: RAINY");
                return 'rainy';
            
            case 'SUNNY':
                console.log("☀️ Mode: SUNNY");
                return 'sunny';
            
            case 'WINDY':
                // No windy.js exists, fall back to cloudy
                console.log("💨 Mode: WINDY (using cloudy.js as fallback)");
                return 'cloudy';
            
            case 'CLOUDY':
            default:
                console.log("☁️ Mode: CLOUDY");
                return 'cloudy';
        }
    } catch (error) {
        console.error("❌ Classification failed:", error);
        return 'cloudy';
    }
}

// =============================================================================
// 3. LOAD WEATHER VISUALIZATION
// =============================================================================

/**
 * Dynamically imports the weather module based on mode.
 * 
 * Each script is self-contained:
 * - Creates its own Three.js scene, camera, renderer
 * - Appends canvas to document.body
 * - Runs its own animation loop
 * - Has hidden GUI (press any key to toggle)
 * 
 * TODO: To add a new weather type:
 * 1. Create the script (e.g. windy.js) following the same pattern
 * 2. Add a case here: case 'windy': await import('./windy.js'); break;
 * 3. Add detection logic in decideModeFromWeather()
 */
async function loadWeatherModule(mode) {
    console.log(`🔄 Loading ${mode}.js ...`);

    switch (mode) {
        case 'sunny':
            await import('./sunny.js');
            break;

        case 'rainy':
            await import('./rainy.js');
            break;

        case 'snowy':
            await import('./snowy.js');
            break;

        case 'cloudy':
        default:
            await import('./cloudy.js');
            break;
    }

    console.log(`✅ ${mode}.js loaded and running`);
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

async function init() {
    console.log("🌍 Weather System starting...");

    // Step 1: Fetch weather
    const weatherData = await fetchWeather();
    
    if (weatherData) {
        const loc = weatherData.location;
        const cur = weatherData.current;
        console.log(`📍 ${loc.name}, ${loc.country}`);
        console.log(`🌡️ ${cur.temp_c}°C | ${cur.condition.text}`);
        console.log(`💨 Wind: ${cur.wind_kph} km/h | ☁️ Cloud: ${cur.cloud}%`);
    }

    // Step 2: Decide mode (uses classifyCategory from weatherapi.js)
    const mode = await decideModeFromWeather(weatherData);

    // Step 3: Load visualization
    await loadWeatherModule(mode);
}

// Run!
init().catch(err => {
    console.error("💥 Init failed:", err);
    // Fallback to cloudy
    console.log("🔄 Loading fallback (cloudy.js)...");
    import('./cloudy.js').catch(e => console.error("Fallback failed:", e));
});

// =============================================================================
// OPTIONAL: AUTO-REFRESH (uncomment to enable)
// =============================================================================
// Reload page every 15 minutes to refresh weather
// Note: This is a simple approach. For smoother transitions,
// you'd need to dispose the current scene and load a new one.
/*
setInterval(() => {
    console.log("🔄 Auto-refreshing weather...");
    location.reload();
}, 15 * 60 * 1000);
*/

