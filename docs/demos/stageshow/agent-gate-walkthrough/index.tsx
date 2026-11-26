import { Bar, Check, Stage, Text, Window, type Act } from '../../kit'
import './walkthrough.css'

// Illustrative product walkthrough of AgentGate's core workflow:
// 1. Opens on the 5-step approval-laundering counterexample (VIOLATED, 44 states).
// 2. Appends `!modifiedSinceApproval` to `publish_release_notes` -> snapshot marks OUTDATED.
// 3. Runs Verify Policy -> bounded BFS explores all 61 reachable states -> VERIFIED (Goal: Yes).

type Phase = 'violated' | 'outdated' | 'verifying' | 'verified'
type S = {
  patched: boolean
  phase: Phase
}

const initial: S = { patched: false, phase: 'violated' }
const poster: S = { patched: true, phase: 'verified' }

const REST = { wide: { x: 584, y: 318 }, compact: { x: 318, y: 304 } }

async function script(a: Act<S>) {
  await a.wait(650)
  a.mark('append')
  await a.move({ at: 'patch', x: 0.88, y: 0.5 })
  await a.wait(180)
  await a.click({ at: 'patch', x: 0.88, y: 0.5 })
  a.put({ patched: true, phase: 'outdated' })
  await a.wait(900)

  a.mark('verify')
  await a.move({ at: 'verify', x: 0.88, y: 0.5 })
  await a.wait(180)
  await a.click({ at: 'verify', x: 0.88, y: 0.5 })
  a.put({ phase: 'verifying' })
  await a.wait(700)

  a.mark('verified')
  a.put({ phase: 'verified' })
  await a.move(a.layout === 'compact' ? REST.compact : REST.wide)
  await a.wait(2200)
}

export default function AgentGateWalkthrough() {
  return (
    <Stage
      width={640}
      height={360}
      compact={{ below: 560, width: 358, height: 336 }}
      greys="cool"
      initial={initial}
      poster={poster}
      script={script}
      play="once"
      cursor={{ at: REST }}
      className="agw"
    >
      {(s) => (
        <Window url="rulecanvaskit.pages.dev/agent-gate" className="agw-win">
          <div className="agw-body">
            <div className="agw-header">
              <div className="agw-title-group">
                <Text className="agw-title">publish_release_notes</Text>
                <Text className="agw-subtitle">Guard rule &amp; bounded BFS verification</Text>
              </div>
              <div className="agw-status-pill" data-phase={s.phase}>
                <span className="agw-layer" data-on={s.phase === 'violated' || undefined}>
                  VIOLATED · 5 steps
                </span>
                <span className="agw-layer" data-on={s.phase === 'outdated' || undefined}>
                  OUTDATED · Draft edited
                </span>
                <span className="agw-layer" data-on={s.phase === 'verifying' || undefined}>
                  RUNNING · BFS worker
                </span>
                <span className="agw-layer" data-on={s.phase === 'verified' || undefined}>
                  VERIFIED · Goal: Yes
                </span>
              </div>
            </div>

            <div className="agw-guard-box" data-patched={s.patched || undefined}>
              <div className="agw-code-line">
                <span className="agw-kw">when</span> stage == &quot;drafting&quot; &amp;&amp; approvalValid
              </div>
              <div className="agw-code-line agw-clause-slot">
                <span className="agw-clause-layer" data-on={!s.patched || undefined}>
                  <span className="agw-muted">// stale approval remains valid after draft mutation</span>
                </span>
                <span className="agw-clause-layer agw-clause-added" data-on={s.patched || undefined}>
                  &amp;&amp; !modifiedSinceApproval
                </span>
              </div>
            </div>

            <div className="agw-actions">
              <span
                className="agw-btn agw-btn-secondary"
                data-target="patch"
                data-cursor="pointer"
                data-done={s.patched || undefined}
              >
                <span className="agw-layer" data-on={!s.patched || undefined}>
                  + !modifiedSinceApproval
                </span>
                <span className="agw-layer" data-on={s.patched || undefined}>
                  Clause appended
                </span>
              </span>

              <span
                className="agw-btn agw-btn-primary"
                data-target="verify"
                data-cursor="pointer"
                data-verified={s.phase === 'verified' || undefined}
              >
                <span className="agw-layer" data-on={(s.phase === 'violated' || s.phase === 'outdated') || undefined}>
                  Verify Policy
                </span>
                <span className="agw-layer agw-busy" data-on={(s.phase === 'verifying' || s.phase === 'verified') || undefined}>
                  <Check on={s.phase === 'verified'} pending={s.phase === 'verifying'} size={14} />
                  <span className="agw-btn-labels">
                    <span className="agw-btn-label" data-on={s.phase === 'verifying' || undefined}>
                      Verifying policy
                    </span>
                    <span className="agw-btn-label" data-on={s.phase === 'verified' || undefined}>
                      Verified · 61 states
                    </span>
                  </span>
                </span>
              </span>
            </div>

            <div className="agw-trace" data-crop>
              <div className="agw-trace-row" data-cleared={s.phase === 'verified' || undefined}>
                <div className="agw-trace-left">
                  <span className="agw-step-id">s5</span>
                  <span className="agw-trace-stack">
                    <span className="agw-layer" data-on={s.phase !== 'verified' || undefined}>
                      inv_no_confidential_publish
                    </span>
                    <span className="agw-layer agw-safe-text" data-on={s.phase === 'verified' || undefined}>
                      inv_no_confidential_publish
                    </span>
                  </span>
                </div>
                <span className="agw-trace-verdict">
                  <span className="agw-layer" data-on={s.phase !== 'verified' || undefined}>
                    FAIL
                  </span>
                  <span className="agw-layer agw-safe-text" data-on={s.phase === 'verified' || undefined}>
                    PASS
                  </span>
                </span>
              </div>
              <div className="agw-bar-row">
                <Bar w={42} h={6} tone={3} />
                <Bar w={168} h={6} tone={2} />
              </div>
              <div className="agw-bar-row">
                <Bar w={36} h={6} tone={3} />
                <Bar w={132} h={6} tone={2} />
              </div>
              <div className="agw-bar-row">
                <Bar w={48} h={6} tone={3} />
                <Bar w={154} h={6} tone={2} />
              </div>
            </div>
          </div>
        </Window>
      )}
    </Stage>
  )
}
