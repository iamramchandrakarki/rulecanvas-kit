import { Bar, Check, Stage, Text, Window, type Act } from '../../kit'
import './walkthrough.css'

// Illustrative product walkthrough of InterlockSim's candidate-repair & verification loop:
// 1. Opens on the 6-step BSL-3 override containment breach (VIOLATED, Step 6/6).
// 2. Clicks `Apply Principled Repair` -> schematic & header show `OUTDATED SNAPSHOT` (candidate change).
// 3. Clicks `Verify Interlock Model` -> explores 29 reachable states -> VERIFIED (Goal: Lab Entry).

type Phase = 'breach' | 'candidate' | 'verifying' | 'verified'
type S = {
  repaired: boolean
  phase: Phase
}

const initial: S = { repaired: false, phase: 'breach' }
const poster: S = { repaired: true, phase: 'verified' }

const REST = { wide: { x: 584, y: 318 }, compact: { x: 318, y: 304 } }

async function script(a: Act<S>) {
  await a.wait(650)
  a.mark('repair')
  await a.move({ at: 'repair', x: 0.88, y: 0.5 })
  await a.wait(180)
  await a.click({ at: 'repair', x: 0.88, y: 0.5 })
  a.put({ repaired: true, phase: 'candidate' })
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

export default function InterlockSimWalkthrough() {
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
      className="isw"
    >
      {(s) => (
        <Window url="rulecanvaskit.pages.dev/interlock-sim" className="isw-win">
          <div className="isw-body">
            <div className="isw-header">
              <div className="isw-title-group">
                <Text className="isw-title">BSL-3 Airlock Interlock</Text>
                <Text className="isw-subtitle">Educational discrete-state containment model</Text>
              </div>
              <div className="isw-status-pill" data-phase={s.phase}>
                <span className="isw-layer" data-on={s.phase === 'breach' || undefined}>
                  VIOLATED · Step 6 / 6
                </span>
                <span className="isw-layer" data-on={s.phase === 'candidate' || undefined}>
                  OUTDATED SNAPSHOT
                </span>
                <span className="isw-layer" data-on={s.phase === 'verifying' || undefined}>
                  VERIFYING · BFS
                </span>
                <span className="isw-layer" data-on={s.phase === 'verified' || undefined}>
                  VERIFIED · Goal: Yes
                </span>
              </div>
            </div>

            <div className="isw-chamber" data-phase={s.phase}>
              <div className="isw-zone">
                <span className="isw-zone-label">Airlock Chamber</span>
                <span className="isw-zone-readout">
                  <span className="isw-layer" data-on={s.phase !== 'verified' || undefined}>
                    dP: EQUALIZED (0 Pa)
                  </span>
                  <span className="isw-layer" data-on={s.phase === 'verified' || undefined}>
                    dP: NEGATIVE (-Pa)
                  </span>
                </span>
              </div>
              <div className="isw-zone isw-zone-door">
                <span className="isw-zone-label">open_inner_door guard</span>
                <span className="isw-zone-readout">
                  <span className="isw-layer" data-on={!s.repaired || undefined}>
                    override bypasses dP
                  </span>
                  <span className="isw-layer isw-guard-fixed" data-on={s.repaired || undefined}>
                    pressure == &quot;negative&quot;
                  </span>
                </span>
              </div>
            </div>

            <div className="isw-actions">
              <span
                className="isw-btn isw-btn-secondary"
                data-target="repair"
                data-cursor="pointer"
                data-done={s.repaired || undefined}
              >
                <span className="isw-layer" data-on={!s.repaired || undefined}>
                  Apply Principled Repair
                </span>
                <span className="isw-layer" data-on={s.repaired || undefined}>
                  Candidate staged
                </span>
              </span>

              <span
                className="isw-btn isw-btn-primary"
                data-target="verify"
                data-cursor="pointer"
                data-verified={s.phase === 'verified' || undefined}
              >
                <span className="isw-layer" data-on={(s.phase === 'breach' || s.phase === 'candidate') || undefined}>
                  Verify Interlock Model
                </span>
                <span className="isw-layer isw-busy" data-on={(s.phase === 'verifying' || s.phase === 'verified') || undefined}>
                  <Check on={s.phase === 'verified'} pending={s.phase === 'verifying'} size={14} />
                  <span className="isw-btn-labels">
                    <span className="isw-btn-label" data-on={s.phase === 'verifying' || undefined}>
                      Verifying model
                    </span>
                    <span className="isw-btn-label" data-on={s.phase === 'verified' || undefined}>
                      Verified · 29 states
                    </span>
                  </span>
                </span>
              </span>
            </div>

            <div className="isw-trace" data-crop>
              <div className="isw-trace-row" data-cleared={s.phase === 'verified' || undefined}>
                <div className="isw-trace-left">
                  <span className="isw-step-id">inv</span>
                  <span className="isw-trace-stack">
                    <span className="isw-layer" data-on={s.phase === 'breach' || undefined}>
                      inv_containment_seal
                    </span>
                    <span className="isw-layer" data-on={(s.phase === 'candidate' || s.phase === 'verifying') || undefined}>
                      inv_containment_seal (stale)
                    </span>
                    <span className="isw-layer isw-safe-text" data-on={s.phase === 'verified' || undefined}>
                      inv_containment_seal
                    </span>
                  </span>
                </div>
                <span className="isw-trace-verdict">
                  <span className="isw-layer" data-on={s.phase !== 'verified' || undefined}>
                    BREACH
                  </span>
                  <span className="isw-layer isw-safe-text" data-on={s.phase === 'verified' || undefined}>
                    HOLD
                  </span>
                </span>
              </div>
              <div className="isw-bar-row">
                <Bar w={44} h={6} tone={3} />
                <Bar w={164} h={6} tone={2} />
              </div>
              <div className="isw-bar-row">
                <Bar w={38} h={6} tone={3} />
                <Bar w={138} h={6} tone={2} />
              </div>
              <div className="isw-bar-row">
                <Bar w={50} h={6} tone={3} />
                <Bar w={152} h={6} tone={2} />
              </div>
            </div>
          </div>
        </Window>
      )}
    </Stage>
  )
}
