/**
 * project-lock.ts: the multi-tab guard for durable media (0.23.0).
 *
 * Every tab that has a project open holds the Web Lock
 * `media-project:<project-id>` in shared mode for the lifetime of that project.
 * The clean action drops this tab's shared hold, requests the same lock in
 * exclusive mode with `ifAvailable`, and refuses to delete anything when the
 * request is not granted. A granted exclusive lock proves no other tab has the
 * project open, because every other open tab holds the shared mode.
 *
 * A browser without Web Locks cannot prove that, so clean is refused there too.
 * Claim shards, not this lock, protect copies that are already closed.
 *
 * Browser-bound: the suite stubs `navigator.locks`.
 */

export type ProjectLockResult<T> =
  { status: 'ran'; value: T } | { status: 'busy' } | { status: 'unsupported' }

/** True when this browser exposes the Web Locks API. */
export function isProjectLockSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function'
}

export function projectLockName(projectId: string): string {
  return `media-project:${projectId}`
}

/**
 * One project's shared hold. `acquire` resolves after the shared lock is
 * granted, so a clean in another tab cannot slip in between "open the project"
 * and "hold the lock".
 */
export class ProjectLock {
  /** Resolves once the shared request has fully settled (the lock is released). */
  private releaseShared: (() => Promise<void>) | null = null
  private holdsShared = false
  private disposed = false

  private constructor(readonly projectId: string) {}

  static async acquire(projectId: string): Promise<ProjectLock> {
    const lock = new ProjectLock(projectId)
    await lock.holdShared()
    return lock
  }

  /** True while this object holds the shared lock. */
  get isHeld(): boolean {
    return this.holdsShared && !this.disposed
  }

  private async holdShared(): Promise<void> {
    if (this.disposed || !isProjectLockSupported()) return
    let release!: () => void
    const lifetime = new Promise<void>((resolve) => {
      release = resolve
    })
    let granted!: () => void
    const ready = new Promise<void>((resolve) => {
      granted = resolve
    })
    let failed = false
    const settled = navigator.locks
      .request(projectLockName(this.projectId), { mode: 'shared' }, async () => {
        granted()
        await lifetime
      })
      // A lock-manager failure must not hang project open, but it must not
      // look held either: without a real shared hold this tab blocks nobody,
      // so `exclusive` refuses instead of deleting uncoordinated.
      .catch(() => {
        failed = true
        granted()
      })
    this.releaseShared = async () => {
      release()
      await settled
    }
    this.holdsShared = true
    await ready
    if (failed || this.disposed) {
      this.holdsShared = false
      this.releaseShared = null
    }
  }

  /**
   * Runs `fn` while holding the project lock exclusively. The shared hold is
   * dropped for the request and restored before this resolves, so the tab keeps
   * announcing that the project is open.
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<ProjectLockResult<T>> {
    if (!isProjectLockSupported() || this.disposed || !this.holdsShared) {
      return { status: 'unsupported' }
    }
    const release = this.releaseShared
    this.releaseShared = null
    this.holdsShared = false
    // Wait for the release to settle: a same-named exclusive request issued
    // while our own shared hold is still registered would fail as busy.
    await release?.()
    let outcome: ProjectLockResult<T> | { status: 'threw'; error: unknown }
    try {
      outcome = await navigator.locks.request(
        projectLockName(this.projectId),
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (!lock) return { status: 'busy' as const }
          // A delete failure must reach the caller, not read as contention:
          // capture it so only lock-manager failures become busy below.
          try {
            return { status: 'ran' as const, value: await fn() }
          } catch (error) {
            return { status: 'threw' as const, error }
          }
        },
      )
    } catch {
      outcome = { status: 'busy' as const }
    } finally {
      await this.holdShared()
    }
    if (outcome.status === 'threw') throw outcome.error
    return outcome
  }

  /** Drops the shared hold. The next project acquires its own lock. */
  dispose(): void {
    this.disposed = true
    this.holdsShared = false
    void this.releaseShared?.()
    this.releaseShared = null
  }
}
