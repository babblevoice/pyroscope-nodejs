import * as pprof from 'pprof'

import type perftools from 'pprof/proto/profile'
import debug from 'debug'
import axios, { AxiosError } from 'axios'
import FormData from 'form-data'

type TagList = Record<string, any>

const log = debug('pyroscope')

export interface PyroscopeConfig {
  server?: string
  name: string
  sourceMapPath?: string[]
  autoStart: boolean
  sm?: any
  tags: TagList
}

const INTERVAL = 10000
const SAMPLERATE = 100
// Base sampling interval, constant for pyroscope
const DEFAULT_SERVER =
  process.env['PYROSCOPE_SERVER'] || 'http://localhost:4040'

const config: PyroscopeConfig = {
  server: DEFAULT_SERVER,
  autoStart: true,
  name: 'nodejs',
  sm: undefined,
  tags: {},
}

export function init(
  c: Partial<PyroscopeConfig> = {
    server: DEFAULT_SERVER,
    autoStart: true,
    name: 'nodejs',
    tags: {},
  }
): void {
  if (c) {
    config.server = c.server || DEFAULT_SERVER
    config.sourceMapPath = c.sourceMapPath
    config.name = c.name || 'nodejs'
    if (!!config.sourceMapPath) {
      pprof.SourceMapper.create(config.sourceMapPath)
        .then((sm) => (config.sm = sm))
        .catch((e) => {
          log(e)
        })
    }
    config.tags = c.tags || {}
  }

  if (c && (c.autoStart || c.autoStart === undefined)) {
    startWallProfiling()
    startHeapProfiling()
  }
}

function handleError(error: AxiosError) {
  if (error.response) {
    // The request was made and the server responded with a status code
    // that falls out of the range of 2xx
    log('Pyroscope received error while ingesting data to server')
    log(error.response.data)
  } else if (error.request) {
    // The request was made but no response was received
    // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
    // http.ClientRequest in node.js
    log('Error when ingesting data to server:', error.message)
  } else {
    // Something happened in setting up the request that triggered an Error
    log('Error', error.message)
  }
}

export const processProfile = (
  profile: perftools.perftools.profiles.IProfile
): perftools.perftools.profiles.IProfile | undefined => {
  const replacements = {
    objects: 'inuse_objects',
    space: 'inuse_space',
    sample: 'samples',
  } as Record<string, string>

  const newStringTable = profile.stringTable
    ?.slice(0, 5)
    .map((s) => (replacements[s] ? replacements[s] : s))
    .concat(profile.stringTable?.slice(5))

  // Inject line numbers and file names into symbols table
  const newProfile = profile.location?.reduce(
    (a, location, i) => {
      // location -> function -> name
      if (location && location.line && a.stringTable) {
        const functionId = location.line[0]?.functionId
        const functionCtx: perftools.perftools.profiles.IFunction | undefined =
          a.function?.find((x) => x.id == functionId)
        const newNameId = a.stringTable.length
        const functionName = a.stringTable[Number(functionCtx?.name)]
        if (functionName.indexOf(':') === -1) {
          const newName = (
            `${a.stringTable[Number(functionCtx?.filename)]}:${
              a.stringTable[Number(functionCtx?.name)]
            }:${location?.line[0].line}` as string
          ).replace(process.cwd(), '.')
          if (functionCtx) {
            functionCtx.name = newNameId
          }

          return {
            ...a,
            location: [...(a.location || [])],
            stringTable: [...(a.stringTable || []), newName],
          }
        } else {
          return a
        }
      }
      return {}
    },
    {
      ...profile,
      stringTable: newStringTable,
    } as perftools.perftools.profiles.IProfile
  )
  return newProfile
}

async function uploadProfile(profile: perftools.perftools.profiles.IProfile) {
  // Apply labels to all samples
  const newProfile = processProfile(profile)

  if (newProfile) {
    const buf = await pprof.encode(newProfile)

    const formData = new FormData()
    formData.append('profile', buf, {
      knownLength: buf.byteLength,
      contentType: 'text/json',
      filename: 'profile',
    })

    const tagList = config.tags
      ? Object.keys(config.tags).map(
          (t: string) =>
            `${encodeURIComponent(t)}=${encodeURIComponent(config.tags[t])}`
        )
      : ''

    const url = `${config.server}/ingest?name=${encodeURIComponent(
      config.name
    )}{${tagList}}&sampleRate=${SAMPLERATE}&spyName=nodeSpy`
    log(`Sending data to ${url}`)
    // send data to the server
    return axios(url, {
      method: 'POST',
      headers: formData.getHeaders(),
      data: formData as any,
    }).catch(handleError)
  }
}

// Could be false or a function to stop heap profiling
let heapProfilingTimer: undefined | NodeJS.Timer = undefined
let isWallProfilingRunning = false

import fs from 'fs'

let chunk = 0
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const writeProfileAsync = (profile: perftools.perftools.profiles.IProfile) => {
  pprof.encode(profile).then((buf) => {
    fs.writeFile(`${config.name}-${chunk}.pb.gz`, buf, (err) => {
      if (err) throw err
      console.log('Chunk written')
      chunk += 1
    })
  })
}

export async function collectCpu(seconds?: number): Promise<Buffer> {
  const profile = await pprof.time.profile({
    lineNumbers: true,
    sourceMapper: config.sm,
    durationMillis: (seconds || 10) * 1000 || INTERVAL,
    intervalMicros: 10000,
  })

  const newProfile = processProfile(profile)
  if (newProfile) {
    return pprof.encode(newProfile)
  } else {
    return new Buffer('', 'utf8')
  }
}

export async function collectHeap(): Promise<Buffer> {
  log('Collecting heap...')
  const profile = pprof.heap.profile(undefined, config.sm)
  const newProfile = processProfile(profile)
  if (newProfile) {
    return pprof.encode(newProfile)
  } else {
    return new Buffer('', 'utf8')
  }
}

export function startWallProfiling(tags: TagList = {}): void {
  log('Pyroscope has started CPU Profiling')
  isWallProfilingRunning = true

  const profilingRound = () => {
    log('Collecting CPU Profile')
    pprof.time
      .profile({
        lineNumbers: true,
        sourceMapper: config.sm,
        durationMillis: INTERVAL,
        intervalMicros: 10000,
      })
      .then((profile) => {
        log('CPU Profile collected')
        if (isWallProfilingRunning) {
          setImmediate(profilingRound)
        }
        log('CPU Profile uploading')
        return uploadProfile(profile)
      })
      .then((d) => {
        log('CPU Profile has been uploaded')
      })
      .catch((e) => {
        log(e)
      })
  }
  profilingRound()
}

// It doesn't stop it immediately, just wait until it ends
export function stopWallProfiling(): void {
  isWallProfilingRunning = false
}

export function startHeapCollecting() {
  const intervalBytes = 1024 * 512
  const stackDepth = 32

  log('Pyroscope has started heap profiling')

  pprof.heap.start(intervalBytes, stackDepth)
}

export function startHeapProfiling(tags: TagList = {}): void {
  if (heapProfilingTimer) return

  startHeapCollecting()

  heapProfilingTimer = setInterval(async () => {
    log('Collecting heap profile')
    const profile = pprof.heap.profile(undefined, config.sm)
    log('Heap profile collected...')
    await uploadProfile(profile)
    log('Heap profile uploaded...')
  }, INTERVAL)
}

export function stopHeapCollecting() {
  pprof.heap.stop()
}

export function stopHeapProfiling(): void {
  if (heapProfilingTimer) {
    log('Stopping heap profiling')
    clearInterval(heapProfilingTimer)
    heapProfilingTimer = undefined
    stopHeapCollecting()
  }
}

export const startCpuProfiling = startWallProfiling
export const stopCpuProfiling = stopWallProfiling

export { expressMiddleware } from './pull/index.js'
import { expressMiddleware } from './pull/index.js'

export default {
  init,
  startCpuProfiling: startWallProfiling,
  stopCpuProfiling: stopWallProfiling,
  startWallProfiling,
  stopWallProfiling,
  startHeapProfiling,
  stopHeapProfiling,
  collectCpu,
  collectHeap,
  startHeapCollecting,
  stopHeapCollecting,

  expressMiddleware,
}
