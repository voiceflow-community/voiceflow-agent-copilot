import axios from 'axios'
import { generateMongoId } from './id-generator.js'

// Helper to robustly extract the first valid JSON object from Anthropic's content array
function extractJsonFromAnthropicResponse(contentArray) {
  //console.log('Anthropic content array:', JSON.stringify(contentArray, null, 2))
  for (const item of contentArray) {
    if (item.type === 'text' && item.text) {
      //console.log('Checking text block:', item.text)
      // Try to extract JSON from triple backticks
      const tripleBacktickMatch =
        item.text.match(/```json\s*([\s\S]+?)```/i) ||
        item.text.match(/```\s*([\s\S]+?)```/i)
      if (tripleBacktickMatch) {
        try {
          return JSON.parse(tripleBacktickMatch[1])
        } catch (e) {
          console.error(
            'Failed to parse JSON from triple backticks:',
            tripleBacktickMatch[1],
            e
          )
        }
      }
      // Try to extract the first {...} JSON block
      const curlyMatch = item.text.match(/{[\s\S]*}/)
      if (curlyMatch) {
        try {
          return JSON.parse(curlyMatch[0])
        } catch (e) {
          console.error(
            'Failed to parse JSON from curly braces:',
            curlyMatch[0],
            e
          )
          console.warn(
            '\n[Warning] The AI response contained invalid JSON. Please review the output and try again if necessary.\n'
          )
        }
      }
    }
  }
  console.warn(
    '\n[Warning] No valid JSON found in the AI response. The tool may not have been added correctly.\n'
  )
  throw new Error('No valid JSON found in Anthropic response')
}

function normalizeLLMApiToolJson(raw) {
  // If url is a string, convert to array of { text: [url] }
  if (typeof raw.url === 'string') {
    raw.url = [{ text: [raw.url] }]
  }
  // If method exists, rename to httpMethod
  if (raw.method && !raw.httpMethod) {
    raw.httpMethod = raw.method.toLowerCase()
    delete raw.method
  }
  // If queryParameters is array of strings, convert to array of objects
  if (
    Array.isArray(raw.queryParameters) &&
    typeof raw.queryParameters[0] === 'string'
  ) {
    raw.queryParameters = raw.queryParameters.map((key) => ({
      id: generateMongoId(),
      key,
      value: [{ text: ['', { variableID: generateMongoId() }, ' '] }],
    }))
  }
  // If variables exists, convert to apiToolInputVariables
  let apiToolInputVariables = []
  if (Array.isArray(raw.variables)) {
    apiToolInputVariables = raw.variables.map((v) => ({
      id: generateMongoId(),
      name: v.name,
      apiToolID: raw.id || generateMongoId(),
      description: v.description || '',
      createdAt: new Date().toISOString(),
    }))
    delete raw.variables
  }
  return { apiTool: raw, apiToolInputVariables }
}

/**
 * Calls Anthropic Sonnet (Claude) API with a prompt and returns the completion.
 * @param {string} prompt - The user prompt.
 * @param {string} [systemPrompt] - Optional system prompt for context.
 * @returns {Promise<string>} - The AI completion text.
 */
export async function askAnthropic(prompt, systemPrompt) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_API_KEY) {
    throw new Error('Missing ANTHROPIC_API_KEY environment variable')
  }
  const url = 'https://api.anthropic.com/v1/messages'
  const headers = {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'anthropic-beta': 'web-search-2025-03-05',
  }
  const data = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    ],
    tools: [
      {
        name: 'web_search',
        type: 'web_search_20250305',
      },
    ],
  }
  try {
    const res = await axios.post(url, data, { headers })
    //console.log(res.data)
    const extracted = extractJsonFromAnthropicResponse(res.data.content)
    // Normalize if needed
    if (
      !extracted.apiTool &&
      !extracted.apiToolInputVariables &&
      !extracted.agentAPITool
    ) {
      return normalizeLLMApiToolJson(extracted)
    }
    return extracted
  } catch (err) {
    throw new Error(
      'Anthropic API error: ' +
        (err.response?.data?.error?.message || err.message)
    )
  }
}
