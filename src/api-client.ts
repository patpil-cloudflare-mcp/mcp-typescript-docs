/**
 * Placeholder API Client
 *
 * This is a minimal placeholder for your custom API client implementation.
 * The skeleton tools in server.ts and api-key-handler.ts do NOT depend on this class,
 * so you can freely rename it and add any methods without causing TypeScript errors.
 *
 * IMPORTANT: When implementing a new MCP server:
 * 1. Rename this class to match your domain (e.g., WeatherApiClient, NewsApiClient)
 * 2. Add your custom methods with appropriate types
 * 3. Delete the skeleton tools in server.ts (they are examples, not dependencies)
 * 4. Implement your actual tools that use your custom API client methods
 */

import type { Env } from "./types";

/**
 * Minimal API Client Placeholder
 *
 * Replace this entire class with your actual implementation.
 *
 * Example custom implementations:
 *
 * ```typescript
 * // Weather API Client
 * export class WeatherApiClient {
 *     private env: Env;
 *     private baseUrl = "https://api.weather.com/v1";
 *
 *     constructor(env: Env) {
 *         this.env = env;
 *     }
 *
 *     async getCurrentWeather(city: string): Promise<WeatherData> {
 *         const response = await fetch(`${this.baseUrl}/current?city=${city}`, {
 *             headers: { "Authorization": `Bearer ${this.env.WEATHER_API_KEY}` }
 *         });
 *         return await response.json();
 *     }
 *
 *     async getForecast(city: string, days: number): Promise<ForecastData> {
 *         // ... implementation
 *     }
 * }
 *
 * // History API Client (from Today in History server)
 * export class HistoryApiClient {
 *     private env: Env;
 *     private baseUrl = "http://history.muffinlabs.com/date";
 *
 *     constructor(env: Env) {
 *         this.env = env;
 *     }
 *
 *     parseDate(dateString: string): { month: number; day: number } {
 *         // Custom date parsing logic
 *     }
 *
 *     async getHistoryForDate(month: number, day: number): Promise<HistoryData> {
 *         // Fetch with KV caching
 *     }
 * }
 * ```
 *
 * Common patterns to include:
 * - Error handling with try/catch
 * - Type-safe request/response interfaces
 * - Retry logic for transient failures
 * - Caching with KV namespace
 * - Rate limiting and backoff
 * - Request/response logging
 */
export class ApiClient {
    private env: Env;

    constructor(env: Env) {
        this.env = env;
    }

    // TODO: Add your custom methods here
    // DO NOT add placeholder methods - they create coupling with skeleton tools
    // Just implement your actual API methods when you're ready
}

/**
 * Optional: Export helper functions
 *
 * Example utility functions you might need:
 * - Data formatting/transformation
 * - Response parsing
 * - Error handling utilities
 * - Cache key generation
 */

// Example helper (remove if not needed):
export function formatApiResponse(rawData: unknown): string {
    return JSON.stringify(rawData, null, 2);
}
