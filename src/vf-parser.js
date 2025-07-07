import fs from 'fs'

/**
 * Load and parse a .vf file as JSON.
 * @param {string} filePath
 * @returns {object}
 */
export function loadVfFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(raw)
}

/**
 * Save a .vf JSON object to file.
 * @param {string} filePath
 * @param {object} data
 */
export function saveVfFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

/**
 * Update the agent's instructions in all locations (programResources.agents and root agents array) for all agents with the same ID, or just the specified agentId if provided.
 * @param {object} data - Parsed .vf JSON
 * @param {string} newInstructions
 * @param {string} [agentId] - Optional agent ID to update
 * @returns {object} - Updated .vf JSON
 */
export function updateAgentInstructions(data, newInstructions, agentId) {
  // Update in programResources.agents
  if (
    data.version &&
    data.version.programResources &&
    data.version.programResources.agents
  ) {
    const agents = data.version.programResources.agents
    for (const id of Object.keys(agents)) {
      if (
        agents[id] &&
        agents[id].instructions !== undefined &&
        (!agentId || id === agentId)
      ) {
        agents[id].instructions = newInstructions
      }
    }
  }
  // Update in root agents array
  if (Array.isArray(data.agents) && data.agents.length > 0) {
    let agentIds = []
    if (
      data.version &&
      data.version.programResources &&
      data.version.programResources.agents
    ) {
      agentIds = Object.keys(data.version.programResources.agents)
    }
    data.agents.forEach((agent) => {
      if (agentIds.includes(agent.id) && (!agentId || agent.id === agentId)) {
        if (
          Array.isArray(agent.instructions) &&
          agent.instructions.length > 0 &&
          agent.instructions[0].text
        ) {
          // Update the text property of the first object
          agent.instructions[0].text = [newInstructions]
        } else {
          // Set as a new array
          agent.instructions = [
            {
              text: [newInstructions],
            },
          ]
        }
      }
    })
  }
  return data
}

/**
 * List all agents (ID and name) from both programResources.agents and root agents array, deduplicated by ID.
 * @param {object} data - Parsed .vf JSON
 * @returns {Array<{id: string, name: string}>}
 */
export function listAllAgents(data) {
  const agentsMap = {}
  // From programResources.agents
  if (
    data.version &&
    data.version.programResources &&
    data.version.programResources.agents
  ) {
    const agents = data.version.programResources.agents
    for (const agentId of Object.keys(agents)) {
      const agent = agents[agentId]
      if (agent) {
        agentsMap[agentId] = { id: agentId, name: agent.name || agentId }
      }
    }
  }
  // From root agents array
  if (Array.isArray(data.agents)) {
    data.agents.forEach((agent) => {
      if (agent && agent.id) {
        agentsMap[agent.id] = { id: agent.id, name: agent.name || agent.id }
      }
    })
  }
  return Object.values(agentsMap)
}
