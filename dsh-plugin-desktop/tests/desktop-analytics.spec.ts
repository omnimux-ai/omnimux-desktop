import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ANALYTICS_ENDPOINT,
  DEFAULT_ANALYTICS_HOSTNAME,
  DEFAULT_ANALYTICS_URL,
  DEFAULT_ANALYTICS_USER_AGENT,
  DEFAULT_ANALYTICS_WEBSITE_ID,
  DesktopAnalyticsClient,
  extractStartupAnalyticsFromSummary,
  FIRST_RUN_REPORTED_RELATIVE_PATH,
} from '../src/desktop-analytics.ts'
import type { DesktopLifecycleSummary } from '../src/lifecycle-events.ts'

const roots: string[] = []

function tempUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-analytics-test-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})

describe('DesktopAnalyticsClient', () => {
  it('formats requests strictly adhering to Umami wire protocol and required headers', async () => {
    const root = tempUserData()
    const captured: Array<{ url: string; init: RequestInit }> = []
    const request = vi.fn(async (url: string, init: RequestInit) => {
      captured.push({ url, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const client = new DesktopAnalyticsClient({
      userDataDir: root,
      request,
    })

    await client.reportStartup({
      appVersion: '2.0.9',
      platform: 'darwin',
      arch: 'arm64',
      totalDurationMs: 1234,
      finalStage: 'health-commit',
      rendererStatus: 'healthy',
      electronReadyMs: 100,
      hostBootMs: 500,
    })

    expect(request).toHaveBeenCalledTimes(1)
    const firstCall = captured[0]!
    expect(firstCall.url).toBe(DEFAULT_ANALYTICS_ENDPOINT)
    const headers = firstCall.init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['User-Agent']).toBe(DEFAULT_ANALYTICS_USER_AGENT)
    expect(headers['x-umami-website-id']).toBe(DEFAULT_ANALYTICS_WEBSITE_ID)
    expect(headers['x-umami-hostname']).toBe(DEFAULT_ANALYTICS_HOSTNAME)

    const parsedBody = JSON.parse(firstCall.init.body as string)
    expect(parsedBody).toEqual({
      type: 'event',
      payload: {
        website: DEFAULT_ANALYTICS_WEBSITE_ID,
        hostname: DEFAULT_ANALYTICS_HOSTNAME,
        url: DEFAULT_ANALYTICS_URL,
        name: 'app-startup',
        data: {
          appVersion: '2.0.9',
          platform: 'darwin',
          arch: 'arm64',
          finalStage: 'health-commit',
          rendererStatus: 'healthy',
          totalDurationMs: 1234,
          electronReadyMs: 100,
          hostBootMs: 500,
        },
      },
    })
  })

  it('reports app-first-run once and creates idempotent marker on disk', async () => {
    const root = tempUserData()
    const request = vi.fn(async () => new Response('{}', { status: 200 }))
    const client = new DesktopAnalyticsClient({
      userDataDir: root,
      request,
    })

    const marker = join(root, FIRST_RUN_REPORTED_RELATIVE_PATH)
    expect(existsSync(marker)).toBe(false)

    // First run
    await client.reportFirstRun('11111111-2222-4333-8444-555555555555', {
      appVersion: '2.0.9',
      platform: 'darwin',
      arch: 'arm64',
    })

    expect(request).toHaveBeenCalledTimes(1)
    expect(existsSync(marker)).toBe(true)
    const markerContent = readFileSync(marker, 'utf8')
    expect(markerContent).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // Second run: should be idempotent and skipped
    await client.reportFirstRun('11111111-2222-4333-8444-555555555555', {
      appVersion: '2.0.9',
      platform: 'darwin',
      arch: 'arm64',
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('reports session exit and measures elapsed duration', async () => {
    const root = tempUserData()
    const captured: Array<{ url: string; init: RequestInit }> = []
    const request = vi.fn(async (url: string, init: RequestInit) => {
      captured.push({ url, init })
      return new Response('{}', { status: 200 })
    })

    let monotonic = 1000
    const client = new DesktopAnalyticsClient({
      userDataDir: root,
      request,
      monotonicNow: () => monotonic,
    })

    monotonic = 7500 // 6500ms elapsed
    await client.reportSessionExit({
      appVersion: '2.0.9',
      platform: 'darwin',
      arch: 'arm64',
    })

    expect(request).toHaveBeenCalledTimes(1)
    const firstCall = captured[0]!
    const parsedBody = JSON.parse(firstCall.init.body as string)
    expect(parsedBody.payload.name).toBe('app-session')
    expect(parsedBody.payload.data).toEqual({
      durationMs: 6500,
      cleanExit: true,
      appVersion: '2.0.9',
      platform: 'darwin',
      arch: 'arm64',
    })

    // Calling exit a second time is guarded
    await client.reportSessionExit({
      appVersion: '2.0.9',
      platform: 'darwin',
      arch: 'arm64',
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('heartbeat periodic reporting works and stops cleanly', async () => {
    vi.useFakeTimers()
    try {
      const root = tempUserData()
      const request = vi.fn(async () => new Response('{}', { status: 200 }))
      let monotonic = 10_000

      const client = new DesktopAnalyticsClient({
        userDataDir: root,
        request,
        monotonicNow: () => monotonic,
      })

      client.startHeartbeat({ appVersion: '2.0.9', platform: 'darwin', arch: 'arm64' }, 1000)

      monotonic += 1000
      vi.advanceTimersByTime(1000)
      expect(request).toHaveBeenCalledTimes(1)

      monotonic += 1000
      vi.advanceTimersByTime(1000)
      expect(request).toHaveBeenCalledTimes(2)

      client.stopHeartbeat()
      monotonic += 1000
      vi.advanceTimersByTime(1000)
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('silently ignores network errors, aborts, and 5xx without throwing', async () => {
    const root = tempUserData()
    const errorRequest = vi.fn(async () => {
      throw new Error('ENOTFOUND analytics.omnimux.ai')
    })
    const client = new DesktopAnalyticsClient({
      userDataDir: root,
      request: errorRequest,
    })

    await expect(client.reportStartup({
      appVersion: '2.0.9',
      platform: 'darwin',
      arch: 'arm64',
    })).resolves.toBeUndefined()

    await expect(client.reportFirstRun('id-1', {
      appVersion: '2.0.9',
      platform: 'darwin',
      arch: 'arm64',
    })).resolves.toBeUndefined()

    await expect(client.reportSessionExit({
      appVersion: '2.0.9',
      platform: 'darwin',
      arch: 'arm64',
    })).resolves.toBeUndefined()
  })

  it('respects disabled flag and does not send any requests', async () => {
    const root = tempUserData()
    const request = vi.fn(async () => new Response('{}', { status: 200 }))
    const client = new DesktopAnalyticsClient({
      userDataDir: root,
      request,
      disabled: true,
    })

    await client.reportFirstRun('uuid', { appVersion: '2.0.9', platform: 'darwin', arch: 'arm64' })
    await client.reportStartup({ appVersion: '2.0.9', platform: 'darwin', arch: 'arm64' })
    await client.reportSessionExit({ appVersion: '2.0.9', platform: 'darwin', arch: 'arm64' })

    expect(request).not.toHaveBeenCalled()
  })

  it('extractStartupAnalyticsFromSummary extracts stages and metadata properly', () => {
    const summary: DesktopLifecycleSummary = {
      schemaVersion: 1,
      eventCount: 10,
      parseErrorCount: 0,
      finalOutcome: 'completed',
      finalStage: 'health-commit',
      rendererStatus: 'healthy',
      totalDurationMs: 1420.5,
      stages: [
        { stageId: 'electron-ready', status: 'completed', durationMs: 120 },
        { stageId: 'host-boot', status: 'completed', durationMs: 650 },
        { stageId: 'renderer-startup', status: 'completed', durationMs: 400 },
      ],
    }

    const data = extractStartupAnalyticsFromSummary(summary, {
      appVersion: '2.0.9',
      platform: 'darwin',
      arch: 'arm64',
    })

    expect(data).toEqual({
      appVersion: '2.0.9',
      platform: 'darwin',
      arch: 'arm64',
      finalStage: 'health-commit',
      rendererStatus: 'healthy',
      totalDurationMs: 1420.5,
      electronReadyMs: 120,
      shellEnvironmentMs: undefined,
      runtimeBootstrapMs: undefined,
      profileSelectionMs: undefined,
      profileCompositionMs: undefined,
      hostBootMs: 650,
      rendererStartupMs: 400,
      healthCommitMs: undefined,
      stages: {
        'electron-ready': 120,
        'host-boot': 650,
        'renderer-startup': 400,
      },
    })
  })
})
