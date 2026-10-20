# named-instance-registry - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**Who this is for and what changes for them:** 누군가 이미 브라우저를 띄워놔도, 같은 이름으로 다시 접속하면 멈추는 대신 그 브라우저에 바로 붙습니다. 브라우저가 죽어 있으면 자동으로 다시 띄우고, 다른 프로필 때문에 못 띄우는 상황에서는 누가 점유 중인지 이름으로 알려줍니다.

**What you'll get:** 이름 붙은 브라우저 레지스트리(connect by name), 실행 중 인스턴스 열람(listInstances), 접속 경로에서도 동일한 탭 API, 이슈 #52를 닫는 PR과 실제 Chromium 수동 QA 증거.

**Why this approach:** 네임드 세션은 TCP이므로 기존 파이프/URL 진입점을 건드리지 않는 별도 API로 추가하고, 탭 생성은 이미 검증된 백그라운드 탭 매니저(createAgentTabs)를 재사용해 런치/attach 두 경로가 같은 동작을 갖게 합니다.

**What it will NOT do:** 이름 없는 기존 호출 방식의 동작 변경, 데몬/네트워크 서비스/새 의존성 추가, 사용처 레포 변경 — 모두 하지 않습니다.

**Effort:** Medium
**Risk:** Medium - 레지스트리 상태(좀비 기록, 포트 재사용, 동시 실행 경쟁)가 correctness의 핵심이라 검증 시나리오가 많음
**Decisions to sanity-check:** 네임드=TCP 127.0.0.1 port=0 + stderr 엔드포인트 발견 / connectNamed 별도 API / 런처 close()=브라우저 종료 vs attach close()=연결만 해제

Your next move: plan-reviewer 리뷰 통과 후 mass-ulw 실행(사용자 상시 지시 2026-10-20). Full execution detail follows below.

---

> TL;DR (machine): Medium | risk Medium | connectNamed/listInstances registry + attach-path newTab + CLI adoption, tests both runners, issue #52 PR via fork, real-Chromium manual QA

## Scope
### Affected user and ideal state
<!-- From the draft ledger: who this touches and how they use the result, then one IS row per property with its reason, then one GAP row per difference with its reason. Every todo below closes a GAP row; ## Success criteria proves every IS row. -->
**Affected user:** (a) 브라우저를 코드로 구동하는 에이전트/개발자 — 오늘은 probe 의식을 외워야 하고 hang 위험을 안며, 이후에는 이름 하나로 attach-or-launch; (b) omowright 스킬(stealth.md 절차가 단일 호출로 단순화); (c) 병렬 에이전트(각자 이름 붙은 엔진 소유); (d) 메인테이너(이슈 #52를 닫는 PR 수령).

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | 이름으로 접속 시 hang 없음: 살아있으면 자동 attach(~1s), 죽은 기록이면 자동 정리 후 재런치 | hang은 stealth.md에 문서화된 실제 결함 |
| IS-2 | attach 클라이언트가 런치와 동일한 탭 API(newTab 포함) 사용 | 오늘 attach 경로는 createTarget 수동 댄스 강요 (connection.js:16-49) |
| IS-3 | CloakBrowser 1인스턴스 충돌 시 점유자(이름/pid/엔드포인트/프로필)를 지목하는 즉시 에러 | 오늘의 9242 프로브는 '누가' 점유했는지 알 수 없음 |
| IS-4 | listInstances()가 기록된 인스턴스를 생존 메타데이터와 함께 열거 | 오늘은 어떤 가시성도 없음 |
| IS-5 | 익명(이름 없는) connectPipe/connectCloakProfile 동작은 바이트 단위로 현행 유지 | 기존 호출 전체에 대한 하위호환 |
| IS-6 | 실제 Chromium 수동 QA가 attach 경로와 stale 복구를 증거와 함께 증명 | 단위 테스트는 fake만 대상 |
| GAP-1 | 레지스트리/네임드 커넥트 없음 (IS-1,3,4 대응) | todo 1,3 |
| GAP-2 | attach 경로 탭 생성 불가 (IS-2 대응) | todo 2 |
| GAP-3 | 익명 경로에 name 개념 없음 — 선택적이어야 함 (IS-5 대응) | todo 3 회귀 테스트 |
| GAP-4 | 수동 QA 부재 (IS-6 대응) | todo 6 |
| GAP-5 | stealth.md/TOOLS.md/README가 수동 의식 교육 (문서 드리프트) | todo 5 |

### Must have
- src/instances.js: connectNamed(name, options), listInstances(), registry primitives — versioned record {version:1,name,pid,endpoint,profileDir,browserPath,startedAt}; dir 0700/files 0600 at ~/.local/share/omowright/instances/; temp+rename atomic write; <name>.lock open(wx) with dead-pid reclaim; kill(pid,0) with EPERM=alive/ESRCH=dead; /json/version probe requiring webSocketDebuggerUrl; alive-pid+dead-endpoint → "unresponsive holder" error
- Named launch: --remote-debugging-address=127.0.0.1 --remote-debugging-port=0; endpoint from stderr "DevTools listening on ws://…" parse (test/scoped-endpoint.test.mjs:40-47 precedent); DevToolsActivePort file fallback
- Cloak serialization: global Cloak launch lock + canonicalized profileDir lock; different-profile conflict error names holder (name/pid/endpoint/profileDir); legacy 9242 probe before launching a different Cloak profile (unregistered holder)
- BrowserConnection.newTab(url="about:blank") via createAgentTabs(this).create(url); remove src/pipe.js:253-256 instance patch
- Ownership: launcher close() terminates the browser (today's semantics, pipe.js browserProcess); attached client close() only detaches
- connectCloakProfile({name}) optional adoption; bin/omowright-cloak --name; connectNamed/listInstances exported from src/index.js
- test/instances.test.mjs + test/fixtures/fake-named-browser.mjs (TCP fake: /json/version + minimal WS CDP); file added to BOTH package.json test/test:node lists
- Docs: skills/omowright/references/stealth.md named flow (manual ritual kept as fallback), TOOLS.md, README.md
- PR body "Closes #52"; fork-flow from synced effortprogrammer/omowright, branch feat/named-instance-registry

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No change to anonymous (name-less) connectPipe/connectCloakProfile wire bytes or behavior
- No daemon, no long-running process, no network service, no new runtime dependencies
- No changes in senpi / oh-my-openagent / omo-desktop-app (zero usage evidence 2026-10-20)
- No commits to main or to code-yeongyu directly; all work on the fork branch
- No absolute home paths in tracked files (hygiene test); write ~/.local/share/... form
- No TaskSpace/ownership semantics beyond the close() contract above; no engine/CDP protocol changes

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after, implementation+tests in ONE todo each. AGENTS.md test-authoring gate: every new test names the contract it protects (registry lifecycle, conflict errors, attach API, anonymous-path regression) and would fail on pre-feature code (the API does not exist there). Framework: bun test + node --test, same files, BOTH package.json lists (AGENTS.md hard rule).
- Evidence: ../.omo/evidence/named-instance-registry/task-<N>.<ext> — relative to the omowright checkout, OUTSIDE the repo, never committed (hygiene-safe); QA scenario paths mirrored in the goal ledger.

## Execution strategy
### Parallel execution waves
- Wave 1 (disjoint write scopes, parallel): todo 1 (src/instances.js core + tests) ∥ todo 2 (connection/pipe newTab move)
- Wave 2: todo 3 (adoption wiring) — needs 1 and 2
- Wave 3 (parallel): todo 4 (suites green + package.json) ∥ todo 5 (docs)
- Wave 4: todo 6 (manual QA, real Chromium) → todo 7 (fork/branch/commits/push/PR)
- Final verification wave: F1-F4 in parallel after todo 7

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 3,4,6 | 2 |
| 2 | — | 3,4 | 1 |
| 3 | 1,2 | 4,5 | — |
| 4 | 1,2,3 | 6,7 | 5 |
| 5 | 3 | 7 | 4 |
| 6 | 4 | 7 | — |
| 7 | 4,5,6 | F-wave | — |
| F1-F4 | 7 | — | each other |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [ ] 1. src/instances.js registry core + connectNamed + unit tests
  What to do / Must NOT do: create src/instances.js with registry primitives (versioned record, atomic temp+rename write, <name>.lock open(wx) with dead-pid reclaim, kill(pid,0) EPERM=alive/ESRCH=dead, /json/version probe requiring webSocketDebuggerUrl), TCP launch helper (--remote-debugging-address=127.0.0.1 --remote-debugging-port=0, stderr "DevTools listening on ws://…" parse, DevToolsActivePort fallback), connectNamed(name, options) attach-or-launch resolution (alive→connect() attach; stale→clean+relaunch; alive+dead-endpoint→"unresponsive holder" error), listInstances(). Create test/fixtures/fake-named-browser.mjs (TCP fake serving /json/version + minimal WS CDP for initialize) and test/instances.test.mjs. Must NOT touch src/pipe.js, src/connection.js, src/cloak-profile.js (todo 2/3 own them).
  Closes: GAP-1 (IS-1, IS-3 core, IS-4)
  Parallelization: Wave 1 | Blocked by: — | Blocks: 3,4,6
  References: src/connection.js:16-57,98 (connect/BrowserConnection/attachPage); src/pipe.js:247-257 (connectPipe shape, launch diagnostics); test/scoped-endpoint.test.mjs:40-47 (port=0 + stderr endpoint precedent); test/fixtures/fake-pipe-browser.mjs:1-34 (fake style, FAKE_BROWSER_MODE); test/pipe.test.mjs:7-49 (pipe test harness); src/cloak-profile.js:20-24,84-123 (0700/0600 metadata pattern, open(wx) atomic-write precedent); AGENTS.md (test gate, hygiene: ~/ paths in docs)
  Acceptance criteria: bun test test/instances.test.mjs && node --test test/instances.test.mjs both exit 0. Tests cover: healthy attach (record alive → connect() attach, listTargets answers), dead-pid clean+relaunch, alive-pid-dead-endpoint rejection, malformed record recovery, lock contention (two concurrent connectNamed same name → one launch), listInstances shape. Do NOT assert newTab here — it lands in todo 2 (parallel Wave 1).
  QA scenarios: happy — connectNamed("qa-1", {fake TCP browser}) returns a BrowserConnection whose listTargets() answers (attach proven); failure — record with dead pid + dead endpoint → relaunch, record rewritten; failure — alive pid + refused endpoint → error contains "unresponsive holder". Evidence ../.omo/evidence/named-instance-registry/task-1.txt
  Commit: Y | feat(instances): named browser registry with attach-or-launch connectNamed
  Recommended task executor category: unspecified-high — multi-concern module (concurrency, atomic IO, process lifecycle) with real integration surface
- [ ] 2. BrowserConnection.newTab + remove pipe.js patch
  What to do / Must NOT do: add async newTab(url = "about:blank") to BrowserConnection in src/connection.js delegating to createAgentTabs(this).create(url) (lazy import mirroring the patch being removed); delete the connectPipe instance patch at src/pipe.js:253-256 so BOTH transports share the class method; keep connectPipe().newTab behavior identical. Must NOT modify AgentTabManager semantics or add exports.
  Closes: GAP-2 (IS-2)
  Parallelization: Wave 1 | Blocked by: — | Blocks: 3,4
  References: src/connection.js:16-57 (class, attachPage, #pages cache); src/pipe.js:247-257 (the patch); src/agent-tabs.js:37-58,140-160 (create: createTarget background + headless activate + attachPage + repinViewport + closeTarget cleanup; createAgentTabs memoizes per connection); test/agent-tabs.test.mjs:6-35; test/interaction.test.mjs (newTab consumers)
  Acceptance criteria: bun test test/pipe.test.mjs test/agent-tabs.test.mjs test/interaction.test.mjs exit 0; grep -n 'connection.newTab' src/pipe.js finds nothing; an attach-path newTab assertion exists in tests.
  QA scenarios: happy — connectPipe(...).newTab("about:blank") returns page (existing tests prove no regression); failure — attach-path newTab when Target.createTarget fails → error propagates, no leaked target. Evidence ../.omo/evidence/named-instance-registry/task-2.txt
  Commit: Y | feat(connection): newTab on BrowserConnection for attach and launch paths
  Recommended task executor category: unspecified-low — small behavioral change, two files plus test fallout
- [ ] 3. Adoption wiring: exports, connectCloakProfile name, CLI --name
  What to do / Must NOT do: export connectNamed/listInstances from src/index.js (match export-list style); add optional name to connectCloakProfile (src/cloak-profile.js:167-185 — named → delegate to connectNamed with resolved cloak args; unnamed → today's exact path, no registry writes) and --name to bin/omowright-cloak.mjs parseArgs (value-flag list :38-50, help text, pass-through). Add regression assertion: anonymous connectCloakProfile creates NO registry artifacts. Must NOT alter cloak identity-flag rejection logic.
  Closes: GAP-1 (API surface), GAP-3 (IS-5)
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 4,5
  References: src/index.js:1-74 (export style); src/cloak-profile.js:97-143,167-185; bin/omowright-cloak.mjs:28-52,68-107 (parseArgs, shutdown, browser.newTab usage); test/cloak-profile.test.mjs (conventions)
  Acceptance criteria: bun test test/cloak-profile.test.mjs green + new anonymous-no-registry assertion passes; node bin/omowright-cloak.mjs --help shows --name; import from src/index.js exposes connectNamed/listInstances.
  QA scenarios: happy — connectCloakProfile({name}) writes a registry record (temp registryRoot); failure — connectCloakProfile({}) leaves no registry dir (temp HOME). Evidence ../.omo/evidence/named-instance-registry/task-3.txt
  Commit: Y | feat(cloak): optional named profiles via connectNamed; omowright-cloak --name
  Recommended task executor category: unspecified-low — wiring across three files on settled patterns
- [ ] 4. Suites green on both runners + package.json lists
  What to do / Must NOT do: add test/instances.test.mjs to BOTH package.json "test" and "test:node" lists; run full bun run test AND bun run test:node — fix only fallout caused by todos 1-3. Must NOT edit or skip pre-existing failing tests (report them instead).
  Closes: proving infrastructure for IS-1/IS-5
  Parallelization: Wave 3 | Blocked by: 1,2,3 | Blocks: 6,7
  References: package.json:35-39 (explicit lists, test:cloak-profile precedent); AGENTS.md (both-runner rule, hygiene test)
  Acceptance criteria: bun run test exit 0 && bun run test:node exit 0 (main was green at a3f0c2b; any pre-existing failure documented with output).
  QA scenarios: happy — both full suites green in one run each; failure — hygiene: no absolute home path introduced (test/hygiene.test.mjs green). Evidence ../.omo/evidence/named-instance-registry/task-4.txt (suite tails + exit codes)
  Commit: Y | test(instances): register the suite on both runners
  Recommended task executor category: quick — mechanical list edit + suite runs
- [ ] 5. Docs: stealth.md named flow + TOOLS.md + README.md
  What to do / Must NOT do: rewrite the "Single-instance rule" section of skills/omowright/references/stealth.md to lead with connectNamed (attach-or-launch, holder error), keeping the curl+connect() ritual as fallback; add connectNamed/listInstances to TOOLS.md in existing bullet style; README gains a feature bullet and one sentence on named TCP (127.0.0.1 port=0) next to the zero-port pipe bullet. Must NOT remove Google/1Password rules or touch unrelated sections; paths written as ~/... (hygiene).
  Closes: GAP-5 (docs drift)
  Parallelization: Wave 3 | Blocked by: 3 | Blocks: 7
  References: skills/omowright/references/stealth.md:17-36; TOOLS.md (tool bullet + export style); README.md:128-190
  Acceptance criteria: grep -c 'connectNamed' across the three changed files ≥ 3; bun test test/skill-docs.test.mjs green.
  QA scenarios: happy — skill-docs test green with new sections; failure — any /Users/ path in changed docs fails hygiene (must not appear). Evidence ../.omo/evidence/named-instance-registry/task-5.txt
  Commit: Y | docs(skill): named instance registry replaces the probe ritual
  Recommended task executor category: writing — three doc surfaces against a settled API
- [ ] 6. Manual QA on a real Chromium
  What to do / Must NOT do: with a locally available Chromium (discover ~/Library/Caches/ms-playwright/chromium_headless_shell-*/... or SHELL_BIN at run time) and a TEMP registryRoot override, run three scenarios: (a) connectNamed("qa-live") launches+registers, capture pid/endpoint; (b) second connectNamed("qa-live") attaches — same pid+endpoint, newTab() works through the attachment, tab closed; (c) kill -9 the browser → third connectNamed("qa-live") cleans the stale record and relaunches (new pid). Must NOT touch the user's real browser profile or the default registry dir; tear down every process and temp dir, record receipts.
  Closes: GAP-4 (IS-6)
  Parallelization: Wave 4 | Blocked by: 4 | Blocks: 7
  References: test/scoped-endpoint.test.mjs:40-47 (real-chromium launch pattern); src/instances.js API from todo 1
  Acceptance criteria: three scenario logs each show the expected pid/endpoint/newTab outcome; teardown receipt recorded (no leftover chrome processes, temp dirs removed).
  QA scenarios: happy — (b) attach: same pid, newTab returns a page; feature-failure-path — (c) stale recovery: new pid ≠ old, record rewritten. Evidence ../.omo/evidence/named-instance-registry/task-6.txt
  Commit: N | evidence only
  Recommended task executor category: unspecified-low — operational script + judgment on captured evidence
- [ ] 7. Fork sync, branch, commits, push, PR
  What to do / Must NOT do: create local branch feat/named-instance-registry from current main; commit todos 1-5 atomically in dependency order (each green alone, conventional subjects per git log, footer "Plan: .omo/plans/named-instance-registry.md"); sync the effortprogrammer/omowright fork to upstream main then push the branch to the FORK (never code-yeongyu — 403); open PR code-yeongyu/omowright ← effortprogrammer:feat/named-instance-registry with body "Closes #52" + summary + QA evidence pointers; watch gh pr checks to green. Must NOT commit to main, force-push, or include ../.omo/evidence artifacts.
  Closes: delivery vehicle for IS-1..IS-6
  Parallelization: Wave 4 | Blocked by:4,5,6 | Blocks: F-wave
  References: git log --oneline -10 (conventional subject style); fork effortprogrammer/omowright (push:true); 403 probe 2026-10-20; issue #52 (created 2026-10-20)
  Acceptance criteria: PR URL returned; gh pr checks green (both CI runners); gh pr view body contains "Closes #52"; PR diff contains only todos 1-5 files plus the plan artifact (.omo/plans/named-instance-registry.md, committed first — matching the tracked .omo/plans/captcha-quality.md convention).
  QA scenarios: happy — PR open + CI green; failure — CI red → fix on branch per its log (never bypass). Evidence ../.omo/evidence/named-instance-registry/task-7.txt (PR URL + checks output)
  Commit: Y | the commits themselves
  Recommended task executor category: git — git/gh mechanics on a settled branch plan

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] 8. Cloak single-instance conflict guard (F1 shortfall repair — added 2026-10-20)
  What to do / Must NOT do: named cloak launches check the registry for a healthy record with a DIFFERENT profileDir and the same browserPath → error naming the holder (name/pid/profileDir); plus a legacy probe for an unregistered engine answering on 127.0.0.1:9242 (skipped when a registered record explains that port); anonymous path untouched.
  Closes: IS-3 remainder (F4 shortfall from todo 1)
  Parallelization: Wave 5 | Blocked by: 7 | Blocks: —
  References: src/cloak-profile.js (assertCloakLaunchClear + named branch); src/instances.js listInstances (alive/responsive)
  Acceptance criteria: bun test + node --test test/cloak-profile.test.mjs → 7 pass incl. "names a healthy different-profile holder" and "detects an unregistered holder on the legacy port".
  QA scenarios: happy — holder-naming error contains name/pid/profile; failure — legacy probe skipped when a registered record's endpoint host equals the probe host. Evidence ../.omo/evidence/named-instance-registry/task-8.txt
  Commit: Y | feat(cloak): name the holder when another CloakBrowser profile or an unregistered instance blocks a launch
  Recommended task executor category: unspecified-low — executed directly by the orchestrator after two child-node evidence fabrications
- [ ] 9. F2 review blocker fixes (added 2026-10-20)
  What to do / Must NOT do: close the 5 blockers from the F2 adversarial review (st_01a15979): engine-wide lock around cloak named launches; nonce-verified lock reclamation; refused-endpoint pid-reuse recovery (stale → relaunch; hanging endpoint still errors); null-profileDir guard in the conflict scan; leak-safe lock writes. Docs updated to the new refused/hung semantics.
  Closes: IS-1/IS-3 review findings
  Parallelization: Wave 6 | Blocked by: 8 | Blocks: —
  References: ../.omo/evidence/named-instance-registry/task-9.txt (fix map + F2 notes N6-N8 recorded)
  Acceptance criteria: bun + node --test on instances+cloak suites → 14 pass / 0 fail each.
  QA scenarios: happy — reused-pid relaunch with registry-hygiene assertion; failure — hanging endpoint still raises unresponsive holder. Evidence ../.omo/evidence/named-instance-registry/task-9.txt
  Commit: Y | fix(instances): close registry races found in review (c4a2e5f)
  Recommended task executor category: unspecified-low — orchestrator-executed
- [ ] F1. Plan compliance audit — every Must-have present in the PR diff, every Must-NOT-have absent; todo rows vs delivered files 1:1; evidence files exist under ../.omo/evidence/named-instance-registry/
- [ ] F2. Code quality review — fresh reviewer over the PR diff (registry concurrency/atomicity, error paths, AGENTS.md conventions)
- [ ] F3. Real manual QA — re-run todo 6 scenarios against the pushed branch HEAD; evidence matches shipped code
- [ ] F4. Ideal-state fidelity — walk IS-1..IS-6 against delivered behavior 1:1; shortfall becomes new todos, never a note

## Commit strategy
- Branch feat/named-instance-registry (local), pushed to fork effortprogrammer/omowright; never main, never code-yeongyu directly
- One atomic commit per todo 1-5 (change + its tests green alone), conventional subjects matching git log history
- Every commit footer: Plan: .omo/plans/named-instance-registry.md
- .omo/drafts and ../.omo/evidence excluded from the PR (evidence lives OUTSIDE the repo)
- PR body: "Closes #52" + what/why + QA evidence summary + verification commands

## Success criteria
> One row per IS row. The plan is complete only when every IS row has a delivering todo and a proving QA scenario; F4 checks the delivered behavior against these rows 1:1, and a shortfall becomes new `- [ ] N.` rows, never a note.
| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | 1,3 | todo 1 happy attach + failure relaunch; todo 6 scenarios (b)(c) live | ../.omo/evidence/named-instance-registry/task-1.txt, task-6.txt |
| IS-2 | 2 | todo 2 attach-path newTab assertion; todo 6 scenario (b) newTab through attachment | ../.omo/evidence/named-instance-registry/task-2.txt, task-6.txt |
| IS-3 | 1 | todo 1 holder/unresponsive error tests | ../.omo/evidence/named-instance-registry/task-1.txt |
| IS-4 | 1,3 | todo 1 listInstances shape test | ../.omo/evidence/named-instance-registry/task-1.txt |
| IS-5 | 3,4 | todo 3 anonymous-no-registry regression + todo 4 full suites green | ../.omo/evidence/named-instance-registry/task-3.txt, task-4.txt |
| IS-6 | 6 | todo 6 three live scenarios + teardown receipt | ../.omo/evidence/named-instance-registry/task-6.txt |
