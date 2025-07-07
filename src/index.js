#!/usr/bin/env node

import dotenv from 'dotenv'
dotenv.config()
import inquirer from 'inquirer'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import path from 'path'
import { fileURLToPath } from 'url'
import * as versioning from './versioning.js'
import * as vfParser from './vf-parser.js'
import fs from 'fs'
import { generateMongoId } from './id-generator.js'
import { askAnthropic } from './anthropic.js'
import { addApiToolFromJson } from './api-tool-templates.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Add robust global handlers for inquirer ExitPromptError and similar user cancellations
function isInquirerExit(err) {
  if (!err) return false
  return (
    err.name === 'ExitPromptError' ||
    err.constructor?.name === 'ExitPromptError' ||
    (typeof err.message === 'string' &&
      err.message.match(/force closed|SIGINT|prompt was closed/i))
  )
}

process.on('unhandledRejection', (err) => {
  if (isInquirerExit(err)) {
    console.log('\nOperation cancelled by user.')
    process.exit(0)
  } else {
    console.error(err && err.message ? err.message : 'Unknown error')
    process.exit(1)
  }
})

process.on('uncaughtException', (err) => {
  if (isInquirerExit(err)) {
    console.log('\nOperation cancelled by user.')
    process.exit(0)
  } else {
    console.error(err && err.message ? err.message : 'Unknown error')
    process.exit(1)
  }
})

// Helper to get all .vf files in projects/
function getVfFiles() {
  const dir = path.join(__dirname, '..', 'projects')
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.vf'))
    .map((f) => path.join(dir, f))
}

// Helper to get all .vf files in template/
function getTemplateVfFiles() {
  const dir = path.join(__dirname, '..', 'template')
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.vf'))
    .map((f) => path.join(dir, f))
}

// Helper to get all versioned files for a base .vf file
function getVersionedFiles(baseFile) {
  const base = path.basename(baseFile, '.vf')
  const dir = path.join(__dirname, '..', 'versions')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(base + '_v') && f.endsWith('.vf'))
    .map((f) => path.join(dir, f))
}

// Helper to get the latest versioned file (or base if none)
function getLatestVfFile(baseFile) {
  const versions = getVersionedFiles(baseFile)
  if (versions.length === 0) return baseFile
  // Sort by timestamp in filename
  return versions.sort().slice(-1)[0]
}

// Prompt user to select a .vf project file or start from template
async function selectProjectFile() {
  const templateFiles = getTemplateVfFiles()
  const vfFiles = getVfFiles()
  if (vfFiles.length === 0 && templateFiles.length === 0) {
    console.error('No .vf files found in projects/ or template/')
    process.exit(1)
  }
  const { projectChoice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'projectChoice',
      message: 'Start from an existing project or a default template?',
      choices: [
        ...(vfFiles.length > 0
          ? [{ name: 'Select a project', value: 'project' }]
          : []),
        ...(templateFiles.length > 0
          ? [{ name: 'Start from template', value: 'template' }]
          : []),
      ],
    },
  ])
  if (projectChoice === 'template') {
    // Let user select from available template files
    const { selectedTemplate } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedTemplate',
        message: 'Select a template (.vf) to start from:',
        choices: templateFiles.map((f) => ({
          name: path.basename(f),
          value: f,
        })),
      },
    ])
    return selectedTemplate
  }
  // Otherwise, select from projects
  const { selectedFile } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedFile',
      message: 'Select a Voiceflow project (.vf) to work on:',
      choices: vfFiles.map((f) => ({ name: path.basename(f), value: f })),
    },
  ])
  return selectedFile
}

// Helper to ensure a versioned file exists for a given base file
function ensureVersionedFile(baseFile) {
  let latest = getLatestVfFile(baseFile)
  if (latest === baseFile) {
    versioning.saveNewVersion(baseFile)
    latest = getLatestVfFile(baseFile)
  }
  return latest
}

// Helper to build a prompt for Anthropic to generate agent instructions
function buildAgentInstructionsPrompt(
  agentName,
  userGoal,
  currentInstructions
) {
  return `You are an expert Voiceflow agent designer.\n\nAgent name: ${agentName}\nUser goal: ${userGoal}\n\nCurrent instructions (if any):\n${
    currentInstructions || 'None'
  }\n\nWrite clear, concise, and effective agent instructions for this agent. Only output the new instructions text, nothing else.`
}

// Helper to build a prompt for Anthropic to generate a Voiceflow API tool JSON
function buildApiToolPrompt(apiDescription) {
  return `You are an expert Voiceflow agent designer.\n\nGiven the following API description or endpoint, generate a Voiceflow API tool definition as a JSON object.\n\nAPI description or endpoint:\n${apiDescription}\n\nOutput a JSON object with the following fields:\n- name (string)\n- description (string)\n- url (string, with {{variable}} for parameters)\n- method (string, e.g., GET, POST)\n- queryParameters (array of strings or objects)\n- variables (array of { name, description })\n\nOnly output the JSON object, nothing else.`
}

// Main CLI entry
async function main() {
  // Accepts either a workingVfFile (string) or argv (object from yargs)
  const addApiTool = async (arg) => {
    let WORKING_VF_FILE
    if (typeof arg === 'string') {
      // Called from setupProject or another command with file path
      WORKING_VF_FILE = arg
    } else if (arg && arg.file) {
      // Called from CLI with a file argument
      WORKING_VF_FILE = ensureVersionedFile(arg.file)
    } else {
      // Called from CLI without a file argument
      const projectFile = await selectProjectFile()
      WORKING_VF_FILE = ensureVersionedFile(projectFile)
    }
    // Load .vf file
    const data = vfParser.loadVfFile(WORKING_VF_FILE)
    const agents = vfParser.listAllAgents(data)
    let selectedAgentId
    if (agents.length === 0) {
      console.error('No agents found in the project.')
      return
    } else if (agents.length === 1) {
      selectedAgentId = agents[0].id
    } else {
      // Prompt user to select agent
      const { agentId } = await inquirer.prompt([
        {
          type: 'list',
          name: 'agentId',
          message:
            'Multiple agents found. Select the agent to add the API tool to:',
          choices: agents.map((a) => ({
            name: `${a.name} (${a.id})`,
            value: a.id,
          })),
        },
      ])
      selectedAgentId = agentId
    }
    // Prompt for API tool details first
    const {
      name,
      description,
      url,
      httpMethod,
      queryParamsInput,
      headersInput,
    } = await inquirer.prompt([
      { type: 'input', name: 'name', message: 'API Tool Name:' },
      { type: 'input', name: 'description', message: 'Description:' },
      {
        type: 'input',
        name: 'url',
        message: 'URL (use {var} or {{var}} for variables):',
      },
      {
        type: 'input',
        name: 'queryParamsInput',
        message:
          'Query parameters (comma-separated key=value, e.g. status=active,user={userId}):',
        default: '',
      },
      {
        type: 'list',
        name: 'httpMethod',
        message: 'HTTP Method:',
        choices: ['get', 'post', 'put', 'delete', 'patch'],
      },
      {
        type: 'input',
        name: 'headersInput',
        message:
          'Headers (comma-separated key:value, e.g. Content-Type:application/json,Authorization:Bearer xyz):',
        default: '',
      },
    ])
    // Only prompt for the body if the method supports it (post, put, patch)
    let bodyTemplate = ''
    if (['post', 'put', 'patch'].includes(httpMethod.toLowerCase())) {
      const { wantsBody } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'wantsBody',
          message: 'Do you want to add a body to this API tool?',
          default: false,
        },
      ])
      if (wantsBody) {
        const { bodyInput } = await inquirer.prompt([
          {
            type: 'editor',
            name: 'bodyInput',
            message:
              'Body template (optional, use {var} or {{var}} for variables):',
            default: '',
          },
        ])
        bodyTemplate = bodyInput
      }
    }
    // Auto-detect variables in URL and query params (match {var} or {{var}})
    const varRegex = /\{+([a-zA-Z0-9_]+)\}+/g
    let match
    const foundVars = new Set()
    while ((match = varRegex.exec(url))) {
      foundVars.add(match[1])
    }
    // Parse query parameters as key=value pairs
    const queryParamPairs = queryParamsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const [key, ...rest] = pair.split('=')
        return { key: key.trim(), value: rest.join('=').trim() }
      })
      .filter((qp) => qp.key)
    // Detect variables in query parameter values
    for (const qp of queryParamPairs) {
      varRegex.lastIndex = 0
      let match
      while ((match = varRegex.exec(qp.value))) {
        foundVars.add(match[1])
      }
    }
    // Detect variables in bodyTemplate BEFORE prompting for descriptions
    if (bodyTemplate && bodyTemplate.trim()) {
      varRegex.lastIndex = 0
      let match
      while ((match = varRegex.exec(bodyTemplate))) {
        foundVars.add(match[1])
      }
    }
    // Collect all unique variable names before prompting for descriptions
    const allVarNames = Array.from(foundVars)
    // Prompt for variable descriptions only once per variable name
    const variableDescriptions = {}
    for (const varName of allVarNames) {
      const { varDesc } = await inquirer.prompt([
        {
          type: 'input',
          name: 'varDesc',
          message: `Description for variable '{${varName}}':`,
          default: '',
        },
      ])
      variableDescriptions[varName] = varDesc
    }
    await versioning.withAutoVersioning(WORKING_VF_FILE, async () => {
      const data = vfParser.loadVfFile(WORKING_VF_FILE)
      // Ensure apiToolInputVariables is always an array
      if (!Array.isArray(data.apiToolInputVariables))
        data.apiToolInputVariables = []
      if (!Array.isArray(data.apiTools)) data.apiTools = []
      // Get creatorID from version
      const creatorID =
        data.version && data.version.creatorID ? data.version.creatorID : null
      // Generate apiToolID first
      const apiToolID = generateMongoId()
      // Prevent duplicate API tool (by name or url)
      const urlStripped = url.replace(varRegex, '{var}')
      const duplicate = data.apiTools.find(
        (t) =>
          t.name === name ||
          (t.url && t.url[0] && t.url[0].text && t.url[0].text.join
            ? t.url[0].text.join('')
            : '') === urlStripped
      )
      if (duplicate) {
        console.error(
          'An API tool with this name or URL already exists. Aborting.'
        )
        return
      }
      const variableIDs = {}
      // Create variable IDs for all unique variable names (reuse within the tool)
      for (const varName of allVarNames) {
        if (!Object.prototype.hasOwnProperty.call(variableIDs, varName)) {
          const varID = generateMongoId()
          data.apiToolInputVariables.push({
            id: varID,
            name: varName,
            apiToolID,
            description: variableDescriptions[varName] || '',
            createdAt: new Date().toISOString(),
          })
          variableIDs[varName] = varID
        }
      }
      // Replace {var} or {{var}} in url with { variableID: ... } objects (Voiceflow format)
      let urlParts = []
      let lastIndex = 0
      varRegex.lastIndex = 0
      while ((match = varRegex.exec(url))) {
        if (match.index > lastIndex) {
          urlParts.push(url.slice(lastIndex, match.index))
        }
        urlParts.push({ variableID: variableIDs[match[1]] })
        lastIndex = match.index + match[0].length
      }
      if (lastIndex < url.length) {
        urlParts.push(url.slice(lastIndex))
      }
      // Build queryParameters array (Voiceflow format, advanced value parsing)
      let queryParameters = []
      for (const qp of queryParamPairs) {
        if (qp.key) {
          // Parse value for {var} or {{var}}
          let valueParts = []
          let lastIndex = 0
          varRegex.lastIndex = 0
          let match
          while ((match = varRegex.exec(qp.value))) {
            if (match.index > lastIndex) {
              valueParts.push(qp.value.slice(lastIndex, match.index))
            }
            valueParts.push({ variableID: variableIDs[match[1]] })
            lastIndex = match.index + match[0].length
          }
          if (lastIndex < qp.value.length) {
            valueParts.push(qp.value.slice(lastIndex))
          }
          queryParameters.push({
            id: generateMongoId(),
            key: qp.key,
            value: [
              {
                text: valueParts,
              },
            ],
          })
        }
      }
      // Build headers array (Voiceflow format)
      let headers = []
      if (headersInput && headersInput.trim()) {
        headers = headersInput.split(',').map((h) => {
          const [key, ...rest] = h.split(':')
          const value = rest.join(':').trim()
          return {
            id: generateMongoId(),
            key: key.trim(),
            value: [
              {
                text: [value],
              },
            ],
          }
        })
      }
      // Build body object (Voiceflow format: { type, content, contentType })
      let body = null
      if (bodyTemplate && bodyTemplate.trim()) {
        let bodyParts = []
        let lastIndex = 0
        varRegex.lastIndex = 0
        let match
        while ((match = varRegex.exec(bodyTemplate))) {
          if (match.index > lastIndex) {
            bodyParts.push(bodyTemplate.slice(lastIndex, match.index))
          }
          // Insert only the variable reference, not an empty object or quotes
          bodyParts.push({ variableID: variableIDs[match[1]] })
          lastIndex = match.index + match[0].length
        }
        if (lastIndex < bodyTemplate.length) {
          bodyParts.push(bodyTemplate.slice(lastIndex))
        }
        // Remove any empty string fragments (but keep valid empty strings for JSON formatting)
        bodyParts = bodyParts.filter(
          (part, idx) =>
            typeof part !== 'object' ||
            part.variableID ||
            typeof part === 'string'
        )
        body = {
          type: 'raw-input',
          content: bodyParts,
          contentType: 'json',
        }
      }
      // Add API tool (with all required fields)
      data.apiTools.push({
        id: apiToolID,
        name,
        description,
        url: [{ text: urlParts }],
        httpMethod,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        queryParameters,
        createdByID: creatorID,
        updatedByID: creatorID,
        folderID: null,
        body,
        image: null,
        headers,
      })
      // Link tool to agent in agentAPITools (with all required fields)
      if (!Array.isArray(data.agentAPITools)) data.agentAPITools = []
      data.agentAPITools.push({
        id: generateMongoId(),
        agentID: selectedAgentId,
        apiToolID,
        createdAt: new Date().toISOString(),
        description: null,
        inputVariables: {},
        captureResponse: null,
      })
      vfParser.saveVfFile(WORKING_VF_FILE, data)
      console.log('API tool and variables added successfully!')
    })
  }

  const updateInstructions = async () => {
    const WORKING_VF_FILE = ensureVersionedFile()
    // Load .vf file
    const data = vfParser.loadVfFile(WORKING_VF_FILE)
    const agents = vfParser.listAllAgents(data)
    let selectedAgentId
    if (agents.length === 0) {
      console.error('No agents found in the project.')
      return
    } else if (agents.length === 1) {
      selectedAgentId = agents[0].id
    } else {
      // Prompt user to select agent
      const { agentId } = await inquirer.prompt([
        {
          type: 'list',
          name: 'agentId',
          message: 'Multiple agents found. Select the agent to update:',
          choices: agents.map((a) => ({
            name: `${a.name} (${a.id})`,
            value: a.id,
          })),
        },
      ])
      selectedAgentId = agentId
    }
    // Prompt for new instructions
    const { newInstructions } = await inquirer.prompt([
      {
        type: 'editor',
        name: 'newInstructions',
        message: 'Enter new agent instructions:',
        default: '',
      },
    ])
    await versioning.withAutoVersioning(WORKING_VF_FILE, async () => {
      const data = vfParser.loadVfFile(WORKING_VF_FILE)
      vfParser.updateAgentInstructions(data, newInstructions, selectedAgentId)
      vfParser.saveVfFile(WORKING_VF_FILE, data)
      console.log(
        `Agent instructions updated for agent ${selectedAgentId} and version saved.`
      )
    })
  }

  const setModel = async () => {
    const WORKING_VF_FILE = ensureVersionedFile()
    // Load models from models.json
    const modelsPath = path.join(__dirname, '..', 'models.json')
    let models
    try {
      models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'))
    } catch (err) {
      console.error('Could not load models.json:', err.message)
      return
    }
    if (!Array.isArray(models) || models.length === 0) {
      console.error('No models found in models.json')
      return
    }
    // Prompt user to select model
    const { selectedModel } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedModel',
        message: 'Select a model for the agent:',
        choices: models.map((m) => ({ name: m.item, value: m.item })),
      },
    ])
    // Load .vf file
    const data = vfParser.loadVfFile(WORKING_VF_FILE)
    const agents = vfParser.listAllAgents(data)
    let selectedAgentId
    if (agents.length === 0) {
      console.error('No agents found in the project.')
      return
    } else if (agents.length === 1) {
      selectedAgentId = agents[0].id
    } else {
      // Prompt user to select agent
      const { agentId } = await inquirer.prompt([
        {
          type: 'list',
          name: 'agentId',
          message: 'Multiple agents found. Select the agent to update:',
          choices: agents.map((a) => ({
            name: `${a.name} (${a.id})`,
            value: a.id,
          })),
        },
      ])
      selectedAgentId = agentId
    }
    await versioning.withAutoVersioning(WORKING_VF_FILE, async () => {
      const data = vfParser.loadVfFile(WORKING_VF_FILE)
      // Update in programResources.agents
      if (
        data.version &&
        data.version.programResources &&
        data.version.programResources.agents &&
        data.version.programResources.agents[selectedAgentId]
      ) {
        if (!data.version.programResources.agents[selectedAgentId].settings) {
          data.version.programResources.agents[selectedAgentId].settings = {}
        }
        data.version.programResources.agents[selectedAgentId].settings.model =
          selectedModel
      }
      // Update in root agents array
      if (Array.isArray(data.agents)) {
        data.agents.forEach((agent) => {
          if (agent.id === selectedAgentId) {
            if (!agent.settings) agent.settings = {}
            agent.settings.model = selectedModel
          }
        })
      }
      vfParser.saveVfFile(WORKING_VF_FILE, data)
      console.log(
        `Model updated to '${selectedModel}' for agent ${selectedAgentId} and version saved.`
      )
    })
  }

  const listVersions = () => {
    const versions = versioning.listVersions()
    if (versions.length === 0) {
      console.log('No versions found.')
    } else {
      console.log('Available versions:')
      versions.forEach((v) => console.log('  ' + v))
    }
  }

  const revertVersion = (argv) => {
    try {
      versioning.revertToVersion(argv.version, WORKING_VF_FILE)
      console.log(`Reverted to version: ${argv.version}`)
    } catch (err) {
      console.error('Error:', err.message)
    }
  }

  // Command to edit project metadata (name and description)
  const editProjectMeta = async () => {
    const WORKING_VF_FILE = ensureVersionedFile()
    const data = vfParser.loadVfFile(WORKING_VF_FILE)
    // Get current values
    const currentName =
      data.version && data.version.name ? data.version.name : ''
    // Prompt for new project name only
    const { newName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'newName',
        message: 'Project name:',
        default: currentName,
      },
    ])
    await versioning.withAutoVersioning(WORKING_VF_FILE, async () => {
      const data = vfParser.loadVfFile(WORKING_VF_FILE)
      if (data.version) {
        data.version.name = newName
        // Also update version.prototype.data.name if present
        if (
          data.version.prototype &&
          data.version.prototype.data &&
          typeof data.version.prototype.data === 'object'
        ) {
          data.version.prototype.data.name = newName
        }
      }
      // Also update project.name if present
      if (data.project && typeof data.project === 'object') {
        data.project.name = newName
      }
      vfParser.saveVfFile(WORKING_VF_FILE, data)
      console.log('Project name updated!')
    })
  }

  // Setup project wizard: select base, set metadata, add API tool
  const setupProject = async () => {
    // 1. Select base project (template or existing)
    const projectFile = await selectProjectFile()
    const WORKING_VF_FILE = ensureVersionedFile(projectFile)
    // 2. Prompt for project metadata
    const data = vfParser.loadVfFile(WORKING_VF_FILE)
    const currentName =
      data.version && data.version.name ? data.version.name : ''
    // Prompt for new project name only
    const { newName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'newName',
        message: 'Project name:',
        default: currentName,
      },
    ])
    await versioning.withAutoVersioning(WORKING_VF_FILE, async () => {
      const data = vfParser.loadVfFile(WORKING_VF_FILE)
      if (data.version) {
        data.version.name = newName
        // Also update version.prototype.data.name if present
        if (
          data.version.prototype &&
          data.version.prototype.data &&
          typeof data.version.prototype.data === 'object'
        ) {
          data.version.prototype.data.name = newName
        }
      }
      // Also update project.name if present
      if (data.project && typeof data.project === 'object') {
        data.project.name = newName
      }
      vfParser.saveVfFile(WORKING_VF_FILE, data)
      console.log('Project name updated!')
    })
    // 3. Ask if user wants to add an API tool
    const { wantsApiTool } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'wantsApiTool',
        message: 'Would you like to add an API tool now?',
        default: true,
      },
    ])
    if (wantsApiTool) {
      await addApiTool(WORKING_VF_FILE)
    } else {
      console.log('Setup complete!')
    }
  }

  const aiUpdateInstructions = async (argv) => {
    process.env.EDITOR = 'nano'
    let projectFile = argv.file
    if (!projectFile) {
      projectFile = await selectProjectFile()
    }
    const workingFile = ensureVersionedFile(projectFile)
    const vfData = JSON.parse(fs.readFileSync(workingFile, 'utf8'))
    // Select agent
    let agents = vfData.programResources?.agents || vfData.agents || []
    if (!Array.isArray(agents) || agents.length === 0) {
      console.log('No agents found in this .vf file.')
      return
    }
    let agent
    if (agents.length === 1) {
      agent = agents[0]
    } else {
      const { agentId } = await inquirer.prompt({
        type: 'list',
        name: 'agentId',
        message: 'Select the agent to update:',
        choices: agents.map((a) => ({ name: a.name || a.id, value: a.id })),
      })
      agent = agents.find((a) => a.id === agentId)
    }
    const { userGoal } = await inquirer.prompt({
      type: 'input',
      name: 'userGoal',
      message:
        'What is the goal or context for this agent? (Describe what you want the agent to do)',
    })
    const currentInstructions = agent.instructions || ''
    const prompt = buildAgentInstructionsPrompt(
      agent.name,
      userGoal,
      currentInstructions
    )
    console.log('\nGenerating new instructions with AI...')
    let aiInstructions
    try {
      aiInstructions = await askAnthropic(prompt)
    } catch (err) {
      console.error('AI error:', err.message)
      return
    }
    // Let user review/edit
    const { finalInstructions } = await inquirer.prompt({
      type: 'editor',
      name: 'finalInstructions',
      message: 'Review and edit the new agent instructions:',
      default: aiInstructions,
    })
    // Update all matching agents (by id) in both locations
    const updateInstructions = (arr) => {
      if (!Array.isArray(arr)) return
      arr.forEach((a) => {
        if (a.id === agent.id) a.instructions = finalInstructions
      })
    }
    updateInstructions(vfData.programResources?.agents)
    updateInstructions(vfData.agents)
    fs.writeFileSync(workingFile, JSON.stringify(vfData, null, 2))
    console.log('Agent instructions updated and saved to', workingFile)
  }

  const aiAddApiTool = async (argv) => {
    process.env.EDITOR = 'nano'
    let projectFile = argv.file
    if (!projectFile) {
      projectFile = await selectProjectFile()
    }
    const workingFile = ensureVersionedFile(projectFile)
    const vfData = JSON.parse(fs.readFileSync(workingFile, 'utf8'))
    const { apiDescription } = await inquirer.prompt({
      type: 'editor',
      name: 'apiDescription',
      message:
        'Describe the API endpoint, paste an OpenAPI snippet, or provide a URL:',
    })
    const prompt = buildApiToolPrompt(apiDescription)
    console.log('\nGenerating API tool definition with AI...')
    let aiJson
    try {
      aiJson = await askAnthropic(prompt)
      // Debug: print the parsed JSON from the LLM
      // console.log('Parsed JSON from LLM:', JSON.stringify(aiJson, null, 2))
    } catch (err) {
      console.error('AI or JSON error:', err.message)
      return
    }
    // Debug: print the validated code that will be added to the project file
    /* console.log(
      'Validated code to add to project:',
      JSON.stringify(aiJson, null, 2)
    ) */
    // Use your existing logic to add the tool to the .vf file (IDs, variables, etc.)
    addApiToolFromJson(aiJson, vfData)
    fs.writeFileSync(workingFile, JSON.stringify(vfData, null, 2))
    console.log('API tool added and saved to', workingFile)
  }

  try {
    yargs(hideBin(process.argv))
      .command(
        'add-api-tool [file]',
        'Add an API tool to your agent',
        (yargs) => {
          yargs.positional('file', {
            describe: 'Path to the .vf file',
            type: 'string',
          })
        },
        addApiTool
      )
      .command(
        'update-instructions',
        'Update agent instructions',
        {},
        updateInstructions
      )
      .command('set-model', "Change the agent's model", {}, setModel)
      .command(
        'list-versions',
        'List all saved project versions',
        {},
        listVersions
      )
      .command(
        'revert-version <version>',
        'Revert to a previous version',
        {},
        revertVersion
      )
      .command(
        'edit-project-meta',
        'Edit project name and description',
        {},
        editProjectMeta
      )
      .command(
        'setup-project',
        'Guided setup: select base, set metadata, add API tool',
        {},
        setupProject
      )
      .command(
        'ai-update-instructions [file]',
        'Use AI to update agent instructions',
        (yargs) => {
          yargs.positional('file', {
            describe: 'Path to the .vf file',
            type: 'string',
          })
        },
        aiUpdateInstructions
      )
      .command(
        'ai-add-api-tool [file]',
        'Use AI to generate and add an API tool',
        (yargs) => {
          yargs.positional('file', {
            describe: 'Path to the .vf file',
            type: 'string',
          })
        },
        aiAddApiTool
      )
      .demandCommand(1, 'You need at least one command before moving on')
      .help().argv

    // Graceful Ctrl+C (SIGINT) handler
    process.on('SIGINT', () => {
      console.log('\nOperation cancelled by user.')
      process.exit(0)
    })
  } catch (err) {
    // Suppress ExitPromptError from inquirer and show a simple message
    if (err && err.name === 'ExitPromptError') {
      console.log('\nOperation cancelled by user.')
      process.exit(0)
    } else {
      console.error(err && err.message ? err.message : 'Unknown error')
      process.exit(1)
    }
  }
}

main().catch((err) => {
  if (isInquirerExit(err)) {
    console.log('\nOperation cancelled by user.')
    process.exit(0)
  } else {
    console.error(err && err.message ? err.message : 'Unknown error')
    process.exit(1)
  }
})
