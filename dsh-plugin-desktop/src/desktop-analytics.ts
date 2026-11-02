/**
 * Lightweight, asynchronous, non-blocking telemetry client for Desktop lifecycle metrics.
 * Follows Umami wire event protocol against analytics.omnimux.ai.
 */

import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopLogger } from './desktop-logger.ts'
import type { DesktopLifecycleSummary } from './lifecycle-events.ts'

export const DEFAULT_ANALYTICS_ENDPOINT = 'https://analytics.omnimux.ai/api/send'
export const DEFAULT_ANALYTICS_WEBSITE_ID = 'dee7cef3-7da5-4a5b-8cc2-6381418d0303'
export const DEFAULT_ANALYTICS_HOSTNAME = 'omnimux-desktop'
export const DEFAULT_ANALYTICS_URL = 'omnimux://desktop'
export const DEFAULT_ANALYTICS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
export const DEFAULT_ANALYTICS_TIMEOUT_MS = 5_000
export const EXIT_ANALYTICS_TIMEOUT_MS = 1_500
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000

export const FIRST_RUN_REPORTED_RELATIVE_PATH = join('identity', 'first-run-reported')

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export type AnalyticsFetchRequest = (url: string, init: RequestInit) => Promise<Response>

export interface DesktopAnalyticsLogger {
  debug?(message: string): void
  error?(message: string): void
}

export interface DesktopAnalyticsOptions {
  readonly endpoint?: string
  readonly websiteId?: string
  readonly hostname?: string
  readonly url?: string
  readonly userAgent?: string
  readonly timeoutMs?: number
  readonly disabled?: boolean
  readonly userDataDir: string
  readonly logger?: DesktopLogger | DesktopAnalyticsLogger
  readonly request?: AnalyticsFetchRequest
  readonly now?: () => Date
  readonly monotonicNow?: () => number
}

export interface DesktopStartupAnalyticsData {
  readonly appVersion: string
  readonly platform: string
  readonly arch: string
  readonly finalStage?: string | undefined
  readonly rendererStatus?: string | undefined
  readonly totalDurationMs?: number | undefined
  readonly electronReadyMs?: number | undefined
  readonly shellEnvironmentMs?: number | undefined
  readonly runtimeBootstrapMs?: number | undefined
  readonly profileSelectionMs?: number | undefined
  readonly profileCompositionMs?: number | undefined
  readonly hostBootMs?: number | undefined
  readonly rendererStartupMs?: number | undefined
  readonly healthCommitMs?: number | undefined
  readonly stages?: Record<string, number | undefined> | undefined
}

export interface DesktopSessionAnalyticsData {
  readonly durationMs: number
  readonly cleanExit: boolean
  readonly appVersion: string
  readonly platform: string
  readonly arch: string
}

export class DesktopAnalyticsClient {
  private readonly endpoint: string
  private readonly websiteId: string
  private readonly hostname: string
  private readonly url: string
  private readonly userAgent: string
  private readonly defaultTimeoutMs: number
  private readonly disabled: boolean
  private readonly userDataDir: string
  private readonly logger: (DesktopLogger | DesktopAnalyticsLogger) | undefined
  private readonly request: AnalyticsFetchRequest
  private readonly now: () => Date
  private readonly monotonicNow: () => number
  private readonly sessionStartTime: number
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private sessionReported = false

  constructor(options: DesktopAnalyticsOptions) {
    this.endpoint = options.endpoint
      ?? process.env.OMNIMUX_ANALYTICS_ENDPOINT
      ?? DEFAULT_ANALYTICS_ENDPOINT
    this.websiteId = options.websiteId
      ?? process.env.OMNIMUX_ANALYTICS_WEBSITE_ID
      ?? DEFAULT_ANALYTICS_WEBSITE_ID
    this.hostname = options.hostname ?? DEFAULT_ANALYTICS_HOSTNAME
    this.url = options.url ?? DEFAULT_ANALYTICS_URL
    this.userAgent = options.userAgent ?? DEFAULT_ANALYTICS_USER_AGENT
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_ANALYTICS_TIMEOUT_MS
    this.disabled = options.disabled
      ?? (process.env.OMNIMUX_ANALYTICS_DISABLED === '1' || process.env.OMNIMUX_ANALYTICS_DISABLED === 'true')
    this.userDataDir = options.userDataDir
    this.logger = options.logger
    this.request = options.request ?? ((url, init) => globalThis.fetch(url, init))
    this.now = options.now ?? (() => new Date())
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.sessionStartTime = this.monotonicNow()
  }

  private logDebug(message: string): void {
    if (this.logger && 'debug' in this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(message)
    }
  }

  /**
   * Report an app-first-run event only once per local installation identity.
   */
  async reportFirstRun(
    installationId: string,
    metadata: { appVersion: string; platform: string; arch: string },
  ): Promise<void> {
    if (this.disabled) return
    const markerPath = join(this.userDataDir, FIRST_RUN_REPORTED_RELATIVE_PATH)
    try {
      if (existsSync(markerPath)) return

      await this.sendEvent('app-first-run', {
        installationId,
        appVersion: metadata.appVersion,
        platform: metadata.platform,
        arch: metadata.arch,
      })

      const dir = dirname(markerPath)
      await mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
      await writeFileAtomic(markerPath, `${this.now().toISOString()}\n`, {
        mode: PRIVATE_FILE_MODE,
        dirMode: PRIVATE_DIRECTORY_MODE,
      })
      try {
        const dirStat = await lstat(dir)
        if (dirStat.isDirectory() && !dirStat.isSymbolicLink()) {
          await chmod(dir, PRIVATE_DIRECTORY_MODE)
        }
      } catch {}
    } catch (cause) {
      this.logDebug(`desktop-analytics: failed to report app-first-run: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  /**
   * Report application startup metrics (success or failure).
   */
  async reportStartup(data: DesktopStartupAnalyticsData): Promise<void> {
    if (this.disabled) return
    try {
      await this.sendEvent('app-startup', {
        appVersion: data.appVersion,
        platform: data.platform,
        arch: data.arch,
        ...(data.finalStage ? { finalStage: data.finalStage } : {}),
        ...(data.rendererStatus ? { rendererStatus: data.rendererStatus } : {}),
        ...(typeof data.totalDurationMs === 'number' ? { totalDurationMs: data.totalDurationMs } : {}),
        ...(typeof data.electronReadyMs === 'number' ? { electronReadyMs: data.electronReadyMs } : {}),
        ...(typeof data.shellEnvironmentMs === 'number' ? { shellEnvironmentMs: data.shellEnvironmentMs } : {}),
        ...(typeof data.runtimeBootstrapMs === 'number' ? { runtimeBootstrapMs: data.runtimeBootstrapMs } : {}),
        ...(typeof data.profileSelectionMs === 'number' ? { profileSelectionMs: data.profileSelectionMs } : {}),
        ...(typeof data.profileCompositionMs === 'number' ? { profileCompositionMs: data.profileCompositionMs } : {}),
        ...(typeof data.hostBootMs === 'number' ? { hostBootMs: data.hostBootMs } : {}),
        ...(typeof data.rendererStartupMs === 'number' ? { rendererStartupMs: data.rendererStartupMs } : {}),
        ...(typeof data.healthCommitMs === 'number' ? { healthCommitMs: data.healthCommitMs } : {}),
      })
    } catch (cause) {
      this.logDebug(`desktop-analytics: failed to report app-startup: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  /**
   * Report app session heartbeat or clean exit.
   */
  async reportSession(data: DesktopSessionAnalyticsData, timeoutMs = this.defaultTimeoutMs): Promise<void> {
    if (this.disabled) return
    try {
      await this.sendEvent('app-session', {
        durationMs: Math.max(0, Math.round(data.durationMs)),
        cleanExit: data.cleanExit,
        appVersion: data.appVersion,
        platform: data.platform,
        arch: data.arch,
      }, timeoutMs)
    } catch (cause) {
      this.logDebug(`desktop-analytics: failed to report app-session: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  /**
   * Start periodic session heartbeat.
   */
  startHeartbeat(metadata: { appVersion: string; platform: string; arch: string }, intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS): void {
    if (this.disabled || this.heartbeatTimer !== undefined) return
    this.heartbeatTimer = setInterval(() => {
      const elapsedMs = this.monotonicNow() - this.sessionStartTime
      void this.reportSession({
        durationMs: elapsedMs,
        cleanExit: false,
        appVersion: metadata.appVersion,
        platform: metadata.platform,
        arch: metadata.arch,
      })
    }, intervalMs)
    if (typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      this.heartbeatTimer.unref()
    }
  }

  /**
   * Stop periodic session heartbeat.
   */
  stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  /**
   * Report session exit during application shutdown with bounded timeout.
   */
  async reportSessionExit(metadata: { appVersion: string; platform: string; arch: string }): Promise<void> {
    if (this.disabled || this.sessionReported) return
    this.sessionReported = true
    this.stopHeartbeat()
    const elapsedMs = this.monotonicNow() - this.sessionStartTime
    await this.reportSession({
      durationMs: elapsedMs,
      cleanExit: true,
      appVersion: metadata.appVersion,
      platform: metadata.platform,
      arch: metadata.arch,
    }, EXIT_ANALYTICS_TIMEOUT_MS)
  }

  /**
   * Core send logic with Umami headers and payload format.
   */
  private async sendEvent(name: string, data: Record<string, unknown>, timeoutMs = this.defaultTimeoutMs): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const body = JSON.stringify({
        type: 'event',
        payload: {
          website: this.websiteId,
          hostname: this.hostname,
          url: this.url,
          name,
          data,
        },
      })

      const response = await this.request(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
          'x-umami-website-id': this.websiteId,
          'x-umami-hostname': this.hostname,
        },
        body,
        signal: controller.signal,
      })

      if (!response.ok) {
        this.logDebug(`desktop-analytics: endpoint responded with status ${response.status}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Helper to build DesktopStartupAnalyticsData from DesktopLifecycleSummary.
 */
export function extractStartupAnalyticsFromSummary(
  summary: DesktopLifecycleSummary,
  metadata: { appVersion: string; platform: string; arch: string },
): DesktopStartupAnalyticsData {
  const stageDurations: Record<string, number | undefined> = {}
  for (const stage of summary.stages) {
    if (stage.durationMs !== undefined) {
      stageDurations[stage.stageId] = stage.durationMs
    }
  }

  const getStage = (id: string) => typeof stageDurations[id] === 'number' ? stageDurations[id] : undefined

  return {
    appVersion: metadata.appVersion,
    platform: metadata.platform,
    arch: metadata.arch,
    ...(summary.finalStage ? { finalStage: summary.finalStage } : {}),
    ...(summary.rendererStatus ? { rendererStatus: summary.rendererStatus } : {}),
    ...(summary.totalDurationMs !== undefined ? { totalDurationMs: summary.totalDurationMs } : {}),
    ...(getStage('electron-ready') !== undefined ? { electronReadyMs: getStage('electron-ready') } : {}),
    ...(getStage('shell-environment') !== undefined ? { shellEnvironmentMs: getStage('shell-environment') } : {}),
    ...(getStage('runtime-bootstrap') !== undefined ? { runtimeBootstrapMs: getStage('runtime-bootstrap') } : {}),
    ...(getStage('profile-selection') !== undefined ? { profileSelectionMs: getStage('profile-selection') } : {}),
    ...(getStage('profile-composition') !== undefined ? { profileCompositionMs: getStage('profile-composition') } : {}),
    ...(getStage('host-boot') !== undefined ? { hostBootMs: getStage('host-boot') } : {}),
    ...(getStage('renderer-startup') !== undefined ? { rendererStartupMs: getStage('renderer-startup') } : {}),
    ...(getStage('health-commit') !== undefined ? { healthCommitMs: getStage('health-commit') } : {}),
    stages: stageDurations,
  }
}
