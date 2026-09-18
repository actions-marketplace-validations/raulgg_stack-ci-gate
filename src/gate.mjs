import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ConfigError,
  decide,
  needsUnmergedDepth,
  parseBottomN,
  parseRunTop,
} from './decide.mjs'
import {
  fetchStack,
  remainingDepthFromStackPulls,
  resolvePull,
} from './github.mjs'

const PR_EVENTS = new Set(['pull_request', 'pull_request_target'])

function readEvent(eventPath) {
  if (!eventPath) return {}
  return JSON.parse(fs.readFileSync(eventPath, 'utf8'))
}

function appendOutput(outputPath, name, value) {
  if (!outputPath) return
  fs.appendFileSync(outputPath, `${name}=${value}\n`)
}

/** GitHub sets INPUT_<id> with the id uppercased; hyphens are kept. */
function inputValue(env, id) {
  return env[`INPUT_${id.toUpperCase()}`]
}

function stringifyBool(value) {
  return value ? 'true' : 'false'
}

function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

function writeOutputs(outputPath, result, log) {
  const reason = oneLine(result.reason)
  appendOutput(outputPath, 'should-run', stringifyBool(result.should_run))
  appendOutput(outputPath, 'reason', reason)
  appendOutput(outputPath, 'is-stacked', stringifyBool(result.is_stacked))
  appendOutput(outputPath, 'is-bottom', stringifyBool(result.is_bottom))
  appendOutput(outputPath, 'is-top', stringifyBool(result.is_top))
  appendOutput(outputPath, 'position', result.position ?? '')
  appendOutput(outputPath, 'size', result.size ?? '')
  log.log(reason)
}

function failOpenResult(message) {
  return {
    should_run: true,
    reason: oneLine(message),
    is_stacked: false,
    is_bottom: false,
    is_top: false,
    position: '',
    size: '',
  }
}

export async function run(env = process.env, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = deps.log ?? console
  const outputPath = env.GITHUB_OUTPUT

  let bottomN
  let runTop
  try {
    bottomN = parseBottomN(inputValue(env, 'bottom-n'))
    runTop = parseRunTop(inputValue(env, 'run-top'))
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(err.message)
      return { exitCode: 1, error: err }
    }
    throw err
  }

  const write = (result) => writeOutputs(outputPath, result, log)
  const eventName = env.GITHUB_EVENT_NAME || ''

  try {
    if (!PR_EVENTS.has(eventName)) {
      const result = decide({
        eventName,
        bottomN,
        runTop,
        stack: null,
        prBaseRef: '',
      })
      write(result)
      return { exitCode: 0, result }
    }

    const event = readEvent(env.GITHUB_EVENT_PATH)
    const pr = event.pull_request ?? {}
    const apiUrl = env.GITHUB_API_URL || 'https://api.github.com'
    const token = inputValue(env, 'github-token') || env.GITHUB_TOKEN || ''
    const repo = env.GITHUB_REPOSITORY || ''

    const resolved = await resolvePull({
      eventAction: event.action,
      eventStack: pr.stack,
      eventPrNumber: pr.number,
      eventPrBaseRef: pr.base?.ref,
      prNumberOverride: inputValue(env, 'pr-number'),
      repo,
      token,
      apiUrl,
      fetchImpl,
      sleep,
    })

    let remainingDepth = null
    if (
      needsUnmergedDepth({
        stack: resolved.stack,
        prBaseRef: resolved.prBaseRef,
        bottomN,
        runTop,
      })
    ) {
      try {
        const stackNumber = resolved.stack?.number
        if (stackNumber == null) {
          throw new Error('stack.number is missing')
        }
        const stackPayload = await fetchStack({
          apiUrl,
          repo,
          stackNumber,
          token,
          fetchImpl,
        })
        remainingDepth = remainingDepthFromStackPulls(
          stackPayload.pull_requests,
          resolved.prNumber,
        )
      } catch (err) {
        log.warn(
          `Failed to list stack members (${err.message}); running CI`,
        )
        remainingDepth = null
      }
    }

    const result = decide({
      eventName,
      bottomN,
      runTop,
      stack: resolved.stack,
      prBaseRef: resolved.prBaseRef,
      remainingDepth,
    })
    write(result)
    return { exitCode: 0, result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`Could not optimize CI; running checks by default. (${message})`)
    const result = failOpenResult(`error; running CI (${message})`)
    write(result)
    return { exitCode: 0, result }
  }
}

function invokedAsCli() {
  if (!process.argv[1]) return false
  try {
    const self = fileURLToPath(import.meta.url)
    const argv = path.resolve(process.argv[1])
    return self === argv || import.meta.url === pathToFileURL(argv).href
  } catch {
    return false
  }
}

if (invokedAsCli()) {
  run()
    .then(({ exitCode }) => {
      process.exit(exitCode ?? 0)
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
