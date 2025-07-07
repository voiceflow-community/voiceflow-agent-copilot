import { generateMongoId } from './id-generator.js'

/**
 * Build a robust prompt for the LLM to generate a Voiceflow-compatible API tool definition.
 * @param {string} apiDescription
 * @returns {string}
 */
export function buildApiToolPrompt(apiDescription) {
  return `You are an expert Voiceflow agent designer tasked with creating a Voiceflow-compatible API tool definition based on an API description or endpoint. Your goal is to generate a single JSON object that includes the apiTool definition, an array of apiToolInputVariables, and an agentAPITool object.

Here is the API description or endpoint you will be working with:
<api_description>
${apiDescription}
</api_description>

Your output must be a single valid JSON object, with no additional prose, explanation, or formatting. Do not wrap your answer in triple backticks or any other markdown.

The JSON object should contain the following top-level keys:
1. "apiTool": An object representing the API tool definition
2. "apiToolInputVariables": An array of objects representing the input variables
3. "agentAPITool": An object representing the agent API tool

The apiTool object should follow this structure:
{
  "id": "<UNIQUE_24_CHAR_HEX_ID>",
  "name": "<Human-Readable Tool Name>",
  "httpMethod": "<get | post | put | patch | delete>",
  "url": [ { "text": [ "<URL_STRING>", { "variableID": "<VARIABLE_ID_IF_IN_URL_PATH>" } ] } ],
  "description": "<Detailed description of what the tool does>",
  "headers": [
    {
      "id": "<UNIQUE_24_CHAR_HEX_ID>",
      "key": "<Header Key>",
      "value": [ { "text": [ "<Header Value>" ] } ]
    }
  ],
  "queryParameters": [
    {
      "id": "<UNIQUE_24_CHAR_HEX_ID>",
      "key": "<Query Parameter Key>",
      "value": [ { "text": [ "", { "variableID": "<VARIABLE_ID>" }, " " ] } ]
    }
  ],
  "body": {
    "type": "raw-input",
    "content": [ "<JSON_STRING_START>", { "variableID": "<VARIABLE_ID>" }, "<JSON_STRING_END>" ],
    "contentType": "json"
  },
  "createdByID": 3600,
  "folderID": null,
  "image": null,
  "createdAt": "<ISO_8601_TIMESTAMP>",
  "updatedAt": "<ISO_8601_TIMESTAMP>",
  "updatedByID": 3600
}

The apiToolInputVariables array should contain objects with this structure:
{
  "id": "<UNIQUE_24_CHAR_HEX_ID>",
  "name": "<variable_name_in_snake_case>",
  "apiToolID": "<ID_OF_THE_API_TOOL_YOU_ARE_CREATING>",
  "description": "<Description of the variable>",
  "createdAt": "<ISO_8601_TIMESTAMP>"
}

The agentAPITool object should follow this structure:
{
  "id": "<UNIQUE_24_CHAR_HEX_ID>",
  "agentID": "<AGENT_ID_FROM_EXISTING_PROJECT_FILE>",
  "apiToolID": "<ID_OF_THE_API_TOOL_YOU_ARE_CREATING>",
  "description": null,
  "inputVariables": {},
  "captureResponse": null
}

When generating the API tool definition:
1. Search online for the latest official API documentation and endpoints for the described API.
2. Be sure to use a working API endpoint for the API tool and prioritize free APIs or APIs that don't require authentication.
3. Use only official documentation and best practices when generating the API tool definition.
4. Include all required fields as shown in the structure above.
5. Generate unique 24-character hexadecimal IDs for all id fields.
6. Use snake_case for variable names.
7. Provide detailed descriptions for the API tool and each input variable.
8. Use ISO 8601 timestamps for createdAt and updatedAt fields.
9. Set sensible defaults for missing fields (e.g., folderID: null, image: null, createdByID: 3600, etc.).
10. Ensure that the httpMethod matches the API endpoint's requirements.
11. Include appropriate headers, query parameters, and body content based on the API documentation.

Remember, your output must be a single valid JSON object containing the apiTool, apiToolInputVariables, and agentAPITool structures. Do not include any additional text or explanations outside of the JSON object.`
}

/**
 * Adds an API tool (from AI JSON) to the Voiceflow .vf data structure.
 * @param {object} aiJson - The AI-generated API tool JSON
 * @param {object} vfData - The loaded .vf data (mutated in place)
 */
export function addApiToolFromJson(aiJson, vfData) {
  if (!aiJson || typeof aiJson !== 'object')
    throw new Error('Invalid AI tool JSON')

  if (!Array.isArray(vfData.apiToolInputVariables))
    vfData.apiToolInputVariables = []
  if (!Array.isArray(vfData.apiTools)) vfData.apiTools = []

  // --- Normalize and validate the tool object ---
  // If the LLM output is wrapped (e.g., { apiTool: {...}, apiToolInputVariables: [...] }), unwrap it
  let toolObj = aiJson.apiTool || aiJson.tool || aiJson
  let variables =
    aiJson.apiToolInputVariables ||
    aiJson.variables ||
    aiJson.apiToolInputVariables ||
    []

  // --- Find all variable names actually referenced in URL, query, or body ---
  const referencedVars = new Set()
  // 1. URL path variables
  if (
    toolObj.url &&
    Array.isArray(toolObj.url) &&
    toolObj.url[0] &&
    toolObj.url[0].text
  ) {
    for (const part of toolObj.url[0].text) {
      if (
        typeof part === 'object' &&
        part.variableID &&
        aiJson.apiToolInputVariables
      ) {
        // Try to find the variable name from the LLM's variables array
        const found = (
          aiJson.apiToolInputVariables ||
          aiJson.variables ||
          []
        ).find((v) => v.id === part.variableID)
        if (found && found.name) referencedVars.add(found.name)
      } else if (typeof part === 'string') {
        // Also scan for {var} or {{var}} in the string
        const matches = part.matchAll(/\{+([a-zA-Z0-9_]+)\}+/g)
        for (const m of matches) referencedVars.add(m[1])
      }
    }
  }
  // 2. Query string variables (from URL)
  let urlStr = ''
  if (
    toolObj.url &&
    Array.isArray(toolObj.url) &&
    toolObj.url[0] &&
    toolObj.url[0].text
  ) {
    urlStr = toolObj.url[0].text
      .map((t) => (typeof t === 'string' ? t : ''))
      .join('')
  } else if (typeof toolObj.url === 'string') {
    urlStr = toolObj.url
  }
  const queryIndex = urlStr.indexOf('?')
  if (queryIndex !== -1) {
    const queryString = urlStr.slice(queryIndex + 1)
    const pairs = queryString
      .split('&')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const pair of pairs) {
      const [key, value] = pair.split('=')
      if (!key) continue
      const varMatch = value && value.match(/^\{+([a-zA-Z0-9_]+)\}+$/)
      if (varMatch) referencedVars.add(varMatch[1])
    }
  }
  // 3. Body variables
  if (
    toolObj.body &&
    toolObj.body.content &&
    Array.isArray(toolObj.body.content)
  ) {
    for (const part of toolObj.body.content) {
      if (
        typeof part === 'object' &&
        part.variableID &&
        aiJson.apiToolInputVariables
      ) {
        const found = (
          aiJson.apiToolInputVariables ||
          aiJson.variables ||
          []
        ).find((v) => v.id === part.variableID)
        if (found && found.name) referencedVars.add(found.name)
      } else if (typeof part === 'string') {
        const matches = part.matchAll(/\{+([a-zA-Z0-9_]+)\}+/g)
        for (const m of matches) referencedVars.add(m[1])
      }
    }
  }

  // --- Only include variables that are actually referenced ---
  variables = aiJson.apiToolInputVariables || aiJson.variables || []
  variables = variables.filter((v) => referencedVars.has(v.name))

  // --- Always generate new IDs for tool, variables, and agentAPITool ---
  const newToolId = generateMongoId()
  // Map old variable names to new IDs
  const newVariables = (variables || []).map((v, idx) => {
    const newId = generateMongoId()
    return {
      id: newId,
      name: v.name || `var${idx + 1}`,
      apiToolID: newToolId,
      description: v.description || '',
      createdAt: new Date().toISOString(),
    }
  })
  const varNameToId = Object.fromEntries(
    newVariables.map((v) => [v.name, v.id])
  )

  // --- Parse query parameters from the URL and build queryParameters array accordingly ---
  let queryParameters = []
  if (queryIndex !== -1) {
    const queryString = urlStr.slice(queryIndex + 1)
    const pairs = queryString
      .split('&')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const pair of pairs) {
      const [key, value] = pair.split('=')
      if (!key) continue
      const varMatch = value && value.match(/^\{+([a-zA-Z0-9_]+)\}+$/)
      if (varMatch) {
        const variableName = varMatch[1]
        const variableID = varNameToId[variableName]
        if (variableID) {
          queryParameters.push({
            id: generateMongoId(),
            key,
            value: [{ text: ['', { variableID }, ' '] }],
          })
        } else {
          // If variable not found, treat as literal
          queryParameters.push({
            id: generateMongoId(),
            key,
            value: [{ text: [value] }],
          })
        }
      } else if (value) {
        // Hardcoded value
        queryParameters.push({
          id: generateMongoId(),
          key,
          value: [{ text: [value] }],
        })
      }
    }
    // Remove query string from urlStr for the url field
    urlStr = urlStr.slice(0, queryIndex)
    // Update toolObj.url to remove query string
    if (
      toolObj.url &&
      Array.isArray(toolObj.url) &&
      toolObj.url[0] &&
      toolObj.url[0].text
    ) {
      toolObj.url[0].text[0] = urlStr
    }
  }

  // If we parsed queryParameters from the URL, override the LLM's array
  if (queryParameters.length > 0) {
    toolObj.queryParameters = queryParameters
  } else {
    // Fallback: use LLM's queryParameters normalization logic (with hardcoded/literal detection)
    toolObj.queryParameters = (toolObj.queryParameters || []).map((qp, idx) => {
      let key = qp.key || qp.name || `param${idx + 1}`
      let variableName = qp.name || qp.key || key
      let variableID = varNameToId[variableName]

      // If the value is a hardcoded string (e.g., 'metric'), use it directly
      if (qp.value && typeof qp.value === 'string') {
        return {
          id: generateMongoId(),
          key,
          value: [{ text: [qp.value] }],
        }
      }

      // If the value is an array with a hardcoded string (e.g., [{ text: ['metric'] }])
      if (
        Array.isArray(qp.value) &&
        qp.value.length === 1 &&
        qp.value[0].text &&
        typeof qp.value[0].text[0] === 'string' &&
        !qp.value[0].text.find((t) => typeof t === 'object' && t.variableID)
      ) {
        return {
          id: generateMongoId(),
          key,
          value: [{ text: [qp.value[0].text[0]] }],
        }
      }

      // If the value is a variable, use the variableID
      if (variableID) {
        return {
          id: generateMongoId(),
          key,
          value: [{ text: ['', { variableID }, ' '] }],
        }
      }

      // Fallback: if no variable and no value, just use an empty string
      return {
        id: generateMongoId(),
        key,
        value: [{ text: [''] }],
      }
    })
  }

  // Remove any fields not present in the working template
  const allowedFields = [
    'id',
    'name',
    'description',
    'url',
    'httpMethod',
    'createdByID',
    'folderID',
    'createdAt',
    'updatedAt',
    'updatedByID',
    'body',
    'image',
    'headers',
    'queryParameters',
  ]
  toolObj = Object.fromEntries(
    Object.entries(toolObj).filter(([k]) => allowedFields.includes(k))
  )

  // Generate new tool fields
  toolObj.id = newToolId
  toolObj.createdByID = 3600
  toolObj.folderID = null
  toolObj.createdAt = new Date().toISOString()
  toolObj.updatedAt = new Date().toISOString()
  toolObj.updatedByID = toolObj.createdByID
  if (!toolObj.body) toolObj.body = null
  if (!toolObj.image) toolObj.image = null
  if (!toolObj.headers) toolObj.headers = []
  if (!toolObj.queryParameters) toolObj.queryParameters = []
  if (!toolObj.url) toolObj.url = [{ text: [''] }]
  if (!toolObj.httpMethod && toolObj.method) toolObj.httpMethod = toolObj.method
  if (!toolObj.httpMethod) toolObj.httpMethod = 'get'
  if (!toolObj.description) toolObj.description = ''
  if (typeof toolObj.url === 'string') toolObj.url = [{ text: [toolObj.url] }]
  if (Array.isArray(toolObj.url) && typeof toolObj.url[0] === 'string')
    toolObj.url = [{ text: toolObj.url }]

  // --- Add to all relevant places in the .vf structure ---
  vfData.apiToolInputVariables.push(...newVariables)
  vfData.apiTools.push({ ...toolObj })

  // Ensure agentAPITools exists
  if (!Array.isArray(vfData.agentAPITools)) vfData.agentAPITools = []

  // Find the first agentID (if available)
  let agentID = null
  if (Array.isArray(vfData.agents) && vfData.agents.length > 0) {
    agentID = vfData.agents[0].id
  }

  // Add a new agentAPITools entry for this tool if agentID is available
  if (agentID) {
    vfData.agentAPITools.push({
      id: generateMongoId(),
      agentID,
      apiToolID: toolObj.id,
      description: null,
      inputVariables: {},
      captureResponse: null,
      createdAt: new Date().toISOString(),
    })
  }

  // --- Clean up URL: remove query params if queryParameters is non-empty, and fix braces ---
  if (
    toolObj.url &&
    Array.isArray(toolObj.url) &&
    toolObj.url.length > 0 &&
    typeof toolObj.url[0].text === 'object' &&
    toolObj.url[0].text.length > 0
  ) {
    let urlStr = toolObj.url[0].text[0]
    if (toolObj.queryParameters && toolObj.queryParameters.length > 0) {
      // Remove query string (everything from ? onwards)
      urlStr = urlStr.split('?')[0]
    }
    // Replace double braces with single braces for path variables
    urlStr = urlStr.replace(/\{\{(.*?)\}\}/g, '{$1}')
    toolObj.url[0].text[0] = urlStr
  }
}
