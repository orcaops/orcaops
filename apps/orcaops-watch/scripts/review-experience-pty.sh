#!/bin/bash
# Drive the production ReviewApp component with injected fixture data through a
# script(1) PTY at the three supported widths.
#
# This asserts REAL EFFECTS ONLY: the command the controller executed, the state
# it produced, and the durable journal events it appended. The rendered frame is
# asserted in `src/tui/review/reviewApp.render.test.tsx`, against the real
# renderer.
#
# What a real PTY buys that unit tests do not: a terminal at real widths,
# proving the fixture-backed Review reader survives keyboard input
# plus xterm SGR menu clicks, hover, horizontal wheel, file selection, native
# scrollbar drag, and modal save/cancel without crashing or hanging.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT_DIR=${1:-/tmp/orcaops-review-experience-pty}
mkdir -p "$OUT_DIR"
cd "$ROOT"
export TERM=xterm-256color

# script(1) is not portable: util-linux takes `-c <cmd> <file>`, BSD/macOS takes
# `<file> <cmd>...`. Getting this wrong is silent — the command becomes the
# capture filename. Detect once.
if script --version 2>/dev/null | grep -qi 'util-linux'; then
  run_pty() { # run_pty <capture> <command>
    script -q -e -c "$2" "$1"
  }
else
  run_pty() {
    script -q "$1" /bin/sh -c "$2"
  }
fi

probe() { # probe <width> <capture>
  run_pty "$2" "stty cols $1 rows 36 2>/dev/null; bun probes/review/probeReviewExperience.tsx"
}

app_probe() { # app_probe <width> <capture>
  run_pty "$2" "stty cols $1 rows 36 2>/dev/null; bun probes/review/probeAppJourney.tsx"
}

log_count() { # log_count <probe-log> <extended-regex>
  grep -Ec -- "$2" "$1" 2>/dev/null || true
}

wait_for_log_count() { # wait_for_log_count <probe-log> <regex> <count> <label>
  local log=$1 pattern=$2 expected=$3 label=$4
  local diagnostic="${log}.${label}-timeout"
  for _attempt in $(seq 1 200); do
    if [[ $(log_count "$log" "$pattern") -ge $expected ]]; then
      return 0
    fi
    sleep 0.05
  done
  {
    echo "observable state timed out after 10 seconds: $label"
    echo "pattern: $pattern"
    echo "expected count: $expected"
    echo "probe log: $log"
    tail -n 80 "$log" 2>/dev/null || true
  } >"$diagnostic"
  echo "review-experience PTY state timeout; diagnostics: $diagnostic" >&2
  return 1
}

wait_ready() { # wait_ready <probe-log>
  wait_for_log_count "$1" '^READY ' 1 ready
}

send_and_wait() { # send_and_wait <bytes> <log-regex> <diagnostic-label>
  local bytes=$1 pattern=$2 label=$3
  local expected=$(( $(log_count "$PROBE_OUT" "$pattern") + 1 ))
  printf '%b' "$bytes"
  wait_for_log_count "$PROBE_OUT" "$pattern" "$expected" "$label"
}

quit_review() { # quit_review <diagnostic-label>
  local label=$1 level command_expected quit_expected
  # Standalone ReviewApp probes have no Watch parent. Respect hierarchical q by
  # unwinding however many Review routes the scenario opened, then quit only
  # from Brief. Eight is comfortably above the bounded product route depth.
  for level in $(seq 1 8); do
    command_expected=$(( $(log_count "$PROBE_OUT" '^command=') + 1 ))
    quit_expected=$(( $(log_count "$PROBE_OUT" 'command=quit') + 1 ))
    printf 'q'
    wait_for_log_count "$PROBE_OUT" '^command=' "$command_expected" "${label}-level-${level}"
    if [[ $(log_count "$PROBE_OUT" 'command=quit') -ge $quit_expected ]]; then
      return 0
    fi
  done
  echo "review-experience PTY did not reach Brief before quit: $label" >&2
  return 1
}

node_field() { # node_field <log> <node-id> <field>
  local log=$1 id=$2 field=$3
  grep -E "^NODE id=${id} present=1 " "$log" | tail -n 1 |
    sed -E "s/.* ${field}=(-?[0-9]+([.][0-9]+)?).*/\1/"
}

wait_for_node() { # wait_for_node <log> <node-id>
  # React can publish a host node one layout pass before Yoga gives it usable
  # geometry. Require the latest observation, not a stale pre-remount match.
  local log=$1 id=$2 latest pattern
  local diagnostic="${log}.node-${id}-timeout"
  pattern="^NODE id=${id} present=1 .*width=[1-9][0-9]*.*height=[1-9][0-9]*"
  for _attempt in $(seq 1 200); do
    latest=$(grep -E "^NODE id=${id} " "$log" | tail -n 1 || true)
    if [[ "$latest" =~ $pattern ]]; then
      return 0
    fi
    sleep 0.05
  done
  {
    echo "current node geometry timed out after 10 seconds: $id"
    echo "latest observation: ${latest:-none}"
    echo "probe log: $log"
    tail -n 80 "$log" 2>/dev/null || true
  } >"$diagnostic"
  echo "review-experience PTY node timeout; diagnostics: $diagnostic" >&2
  return 1
}

mouse_event() { # mouse_event <button> <x-zero-based> <y-zero-based> <M|m>
  local button=$1 x=$2 y=$3 suffix=$4
  printf '\033[<%s;%s;%s%s' "$button" "$((x + 1))" "$((y + 1))" "$suffix"
}

mouse_click_at() { # mouse_click_at <x-zero-based> <y-zero-based>
  mouse_event 0 "$1" "$2" M
  mouse_event 0 "$1" "$2" m
}

mouse_node_point() { # mouse_node_point <log> <node-id> <click|move>
  local log=$1 id=$2 kind=$3 x y width height target_x target_y
  wait_for_node "$log" "$id"
  x=$(node_field "$log" "$id" x)
  y=$(node_field "$log" "$id" y)
  width=$(node_field "$log" "$id" width)
  height=$(node_field "$log" "$id" height)
  target_x=$(( x + (width > 1 ? width / 2 : 0) ))
  target_y=$(( y + (height > 1 ? height / 2 : 0) ))
  if [[ "$kind" == "move" ]]; then
    mouse_event 35 "$target_x" "$target_y" M
  else
    mouse_click_at "$target_x" "$target_y"
  fi
}

mouse_wheel_node() { # mouse_wheel_node <log> <node-id> <button: 64..67>
  local log=$1 id=$2 button=$3 x y width height
  wait_for_node "$log" "$id"
  x=$(node_field "$log" "$id" x)
  y=$(node_field "$log" "$id" y)
  width=$(node_field "$log" "$id" width)
  height=$(node_field "$log" "$id" height)
  mouse_event "$button" "$(( x + width / 2 ))" "$(( y + (height > 3 ? 2 : 0) ))" M
}

mouse_drag_scrollbar_to_bottom() { # mouse_drag_scrollbar_to_bottom <log> <node-id>
  local log=$1 id=$2 x y width height target_x start_y end_y step current_y
  wait_for_node "$log" "$id"
  x=$(node_field "$log" "$id" x)
  y=$(node_field "$log" "$id" y)
  width=$(node_field "$log" "$id" width)
  height=$(node_field "$log" "$id" height)
  target_x=$(( x + width - 1 ))
  start_y=$(( y + 1 ))
  end_y=$(( y + height - 2 ))
  step=$(( (end_y - start_y) / 4 ))
  if [[ $step -lt 1 ]]; then step=1; fi
  mouse_event 0 "$target_x" "$start_y" M
  current_y=$(( start_y + step ))
  while [[ $current_y -lt $end_y ]]; do
    mouse_event 32 "$target_x" "$current_y" M
    current_y=$(( current_y + step ))
  done
  mouse_event 32 "$target_x" "$end_y" M
  mouse_event 0 "$target_x" "$end_y" m
}

drive_app_journey() {
  local expected retained_state_expected branch index
  wait_ready "$PROBE_OUT"
  # The reviewable current checkout is deliberately deep enough to require the
  # Watch rail to scroll. Wait on each rendered selection before sending the
  # next key; a PTY byte reaching stdin is not proof React committed its effect.
  for index in $(seq 1 17); do
    branch=$(printf 'branch-%02d' "$index")
    send_and_wait 'j' "^WATCH_SELECTION branch=${branch}$" "app-select-${branch}"
  done
  send_and_wait 'j' '^WATCH_SELECTION branch=probe$' app-select-reviewable

  # Resolve the selected artifact into its task row through the registered View
  # menu command, then prove the task member itself is a one-click route.
  mouse_node_point "$PROBE_OUT" shell-menu-view click
  mouse_node_point "$PROBE_OUT" shell-menu-item-watch.cycle-grouping click
  wait_for_log_count "$PROBE_OUT" '^WATCH_GROUP value=none$' 1 app-group-none
  mouse_node_point "$PROBE_OUT" shell-menu-view click
  mouse_node_point "$PROBE_OUT" shell-menu-item-watch.cycle-grouping click
  wait_for_log_count "$PROBE_OUT" '^WATCH_GROUP value=task$' 1 app-group-task
  wait_for_node "$PROBE_OUT" 'watch-task-row-task:journey-project:probe'
  wait_for_log_count "$PROBE_OUT" '^WATCH_DETAIL level=task$' 1 app-task-detail
  expected=$(( $(log_count "$PROBE_OUT" '^WATCH_DETAIL level=thread$') + 1 ))
  mouse_node_point "$PROBE_OUT" 'watch-task-member:thread:journey-artifact' click
  wait_for_log_count "$PROBE_OUT" '^WATCH_DETAIL level=thread$' "$expected" app-task-member-open
  send_and_wait 'q' '^WATCH_DETAIL level=task$' app-task-member-q
  send_and_wait 'q' '^WATCH_PANE value=rail$' app-task-detail-q

  send_and_wait 'v' '^ROUTE mode=review' app-enter-review
  wait_for_log_count "$PROBE_OUT" '^REVIEW_READY count=1' 1 app-review-ready

  # Open contextual Help through two real pointer targets: top menu, then row.
  mouse_node_point "$PROBE_OUT" shell-menu-help click
  mouse_node_point "$PROBE_OUT" shell-menu-item-help click
  wait_for_log_count "$PROBE_OUT" '^APP_OVERLAY help=open' 1 app-pointer-help-open
  expected=$(( $(log_count "$PROBE_OUT" '^APP_OVERLAY help=closed') + 1 ))
  mouse_node_point "$PROBE_OUT" help-entry-0-3 click
  wait_for_log_count "$PROBE_OUT" '^APP_OVERLAY help=closed' "$expected" app-pointer-help-execute
  send_and_wait '?' '^APP_OVERLAY help=open' app-keyboard-help-open
  send_and_wait 'q' '^APP_OVERLAY help=closed' app-keyboard-help-q

  # Pointer lens changes must update the same active markers as keyboard paths.
  mouse_node_point "$PROBE_OUT" shell-menu-review click
  mouse_node_point "$PROBE_OUT" shell-menu-item-captured-checkpoint-lens click
  wait_for_log_count "$PROBE_OUT" '^LENSES checkpoints=✓ Checkpoints' 1 app-pointer-checkpoints
  expected=$(( $(log_count "$PROBE_OUT" '^LENSES checkpoints=Checkpoints story=✓ Story') + 1 ))
  mouse_node_point "$PROBE_OUT" shell-menu-review click
  mouse_node_point "$PROBE_OUT" shell-menu-item-story-lens click
  wait_for_log_count "$PROBE_OUT" '^LENSES checkpoints=Checkpoints story=✓ Story' "$expected" app-pointer-story

  # Explicit pointer Back is route navigation, not transient grain or pane
  # cancellation: one committed click moves Walk directly to Brief.
  expected=$(( $(log_count "$PROBE_OUT" '^REVIEW_STATE screen=brief depth=0 ') + 1 ))
  mouse_node_point "$PROBE_OUT" shell-action-review-back click
  wait_for_log_count "$PROBE_OUT" '^REVIEW_STATE screen=brief depth=0 ' "$expected" app-pointer-back-review-root
  retained_state_expected=$(( $(log_count "$PROBE_OUT" '^REVIEW_STATE screen=brief depth=0 ') + 1 ))
  expected=$(( $(log_count "$PROBE_OUT" '^ROUTE mode=watch') + 1 ))
  mouse_node_point "$PROBE_OUT" shell-action-back-to-watch click
  wait_for_log_count "$PROBE_OUT" '^ROUTE mode=watch' "$expected" app-pointer-back-watch

  # Watch selection and Review controller survive an actual unmount/remount.
  expected=$(( $(log_count "$PROBE_OUT" '^ROUTE mode=review') + 1 ))
  printf 'v'
  wait_for_log_count "$PROBE_OUT" '^ROUTE mode=review' "$expected" app-reenter-review
  wait_for_log_count "$PROBE_OUT" '^REVIEW_READY count=2' 1 app-review-reready
  wait_for_log_count "$PROBE_OUT" '^REVIEW_STATE screen=brief depth=0 ' "$retained_state_expected" app-review-state-retained

  # Build a three-level route stack through real input: deterministic Brief →
  # diff → Comments → the new comment's code anchor. Esc and q must each remove
  # only one route; neither can jump to Watch while a Review parent remains.
  expected=$(( $(log_count "$PROBE_OUT" '^LENSES checkpoints=✓ Checkpoints') + 1 ))
  mouse_node_point "$PROBE_OUT" shell-menu-review click
  mouse_node_point "$PROBE_OUT" shell-menu-item-captured-checkpoint-lens click
  wait_for_log_count "$PROBE_OUT" '^LENSES checkpoints=✓ Checkpoints' "$expected" app-pointer-checkpoints-reenter
  send_and_wait '\r' '^REVIEW_STATE screen=floor-diff depth=1 .*hunk=hunk_story_owned_p1 ' app-brief-open
  send_and_wait 'c' '^REVIEW_COMMAND command=comment screen=floor-diff depth=1 ' app-comment-compose
  wait_for_node "$PROBE_OUT" review-input-modal-action-save
  printf 'pty hierarchy comment'
  send_and_wait '\023' '^REVIEW_STATE screen=floor-diff depth=1 .*notice=Comment filed$' app-comment-save
  send_and_wait 'C' '^REVIEW_STATE screen=comments depth=2 ' app-comments-open
  send_and_wait '\r' '^REVIEW_STATE screen=floor-diff depth=3 ' app-comment-anchor
  send_and_wait '\033' '^REVIEW_STATE screen=comments depth=2 ' app-anchor-route-escape
  send_and_wait 'q' '^REVIEW_STATE screen=floor-diff depth=1 ' app-comments-q
  send_and_wait 'q' '^REVIEW_STATE screen=brief depth=0 ' app-diff-q
  expected=$(( $(log_count "$PROBE_OUT" '^ROUTE mode=watch') + 1 ))
  send_and_wait '\033' '^ROUTE mode=watch' app-brief-escape
  wait_for_log_count "$PROBE_OUT" '^ROUTE mode=watch' "$expected" app-keyboard-escape-watch
  # The process-level Ctrl-C escape remains above every menu, modal, and screen command.
  printf '\003'
}

drive_navigation() {
  wait_ready "$PROBE_OUT"
  # The Brief's tree pane holds initial focus with the first Part already
  # selected — its attention queue lives in the other pane behind n/N — so
  # Enter opens Part 1 directly.
  send_and_wait '\r' '^STATE screen=walk focus=diff' enter-walk

  # Parts open on their code just like checkpoints, so j/k move the diff until
  # the rail is focused explicitly. The rail cursor is passive: j selects an
  # item and Enter activates it. Exercise all three item treatments — ordinary
  # source context opens a detail route, the ledger points back to code, and
  # the cross-page plan decision exposes two semantic-anchor locations.
  send_and_wait 'j' 'command=move-diff-slice:1' entry-next-slice
  send_and_wait 'k' 'command=move-diff-slice:-1' entry-previous-slice
  send_and_wait '\t' 'command=none screen=walk focus=rail' focus-story-rail
  send_and_wait 'k' 'command=none screen=walk focus=rail' select-ledger-before-context
  send_and_wait 'k' 'command=none screen=walk focus=rail' select-unplaced-context
  send_and_wait '\r' 'command=none screen=captured-context' open-unplaced-context
  send_and_wait '\033' 'command=none screen=walk' leave-unplaced-context
  send_and_wait 'j' 'command=none screen=walk focus=rail' select-ledger-context
  send_and_wait '\r' 'command=none screen=walk focus=diff' open-ledger-context
  send_and_wait '\t' 'command=none screen=walk focus=rail' refocus-story-rail
  send_and_wait 'j' 'command=none screen=walk focus=rail' select-plan-anchor
  send_and_wait '\r' 'command=none screen=walk focus=diff' open-plan-anchor
  send_and_wait ')' 'command=none.*target=1' cycle-target
  send_and_wait '(' 'command=none.*target=0' reverse-cycle-target
  send_and_wait '\033[D' 'command=none.*grain=hunk' anchor-return-slice-grain
  send_and_wait 'j' 'command=move-diff-slice:1' next-slice
  send_and_wait 'k' 'command=move-diff-slice:-1' previous-slice
  send_and_wait '\033[B' 'command=move-diff-slice:1' arrow-next-slice
  send_and_wait '\033[A' 'command=move-diff-slice:-1' arrow-previous-slice
  send_and_wait '\033[C' 'command=none.*grain=row' right-enter-row-grain
  send_and_wait 'j' 'command=move-diff-row:1' next-row
  send_and_wait 'k' 'command=move-diff-row:-1' previous-row
  send_and_wait '\033[B' 'command=move-diff-row:1' arrow-next-row
  send_and_wait '\033[A' 'command=move-diff-row:-1' arrow-previous-row
  send_and_wait '\033[D' 'command=none.*grain=hunk' left-return-slice-grain
  send_and_wait '\033[C' 'command=none.*grain=row' right-reenter-row-grain
  send_and_wait 'v' 'command=select-range' select-range
  send_and_wait '\033' 'command=none.*grain=row' clear-range-selection
  send_and_wait '\033' 'command=none.*grain=hunk' escape-row-grain
  send_and_wait 'z' 'command=expand-hidden:next' expand-next
  send_and_wait 'Z' 'command=expand-hidden:file' expand-file
  send_and_wait 'u' 'command=page:up:half' page-up-half
  send_and_wait '\025' 'command=page:up:half' ctrl-page-up-half
  send_and_wait 'b' 'command=page:up:full' page-up-full
  send_and_wait 'D' 'command=page:down:half' page-down-half
  send_and_wait '\004' 'command=page:down:half' ctrl-page-down-half
  send_and_wait 'f' 'command=page:down:full' page-down-full
  send_and_wait 'g' 'command=scroll-diff-edge:top' diff-top
  send_and_wait 'G' 'command=scroll-diff-edge:bottom' diff-bottom
  send_and_wait '\014' 'command=recenter-diff' recenter-diff
  send_and_wait '.' 'command=move-diff-file:1' next-file
  send_and_wait ',' 'command=move-diff-file:-1' previous-file
  send_and_wait 'R' 'command=refresh' refresh
  send_and_wait 'C' 'command=none screen=comments' comments
  send_and_wait '\033' 'command=none screen=walk' leave-comments
  send_and_wait '?' '^OVERLAY help=open' help
  send_and_wait '?' '^OVERLAY help=closed' close-help
  send_and_wait 'F' 'command=none screen=flat-files' open-flat-files
  send_and_wait '\r' '^STATE screen=walk focus=diff grain=hunk hunk=hunk_story_owned_p1' activate-flat-file
  send_and_wait 'j' 'command=move-diff-slice:1' flat-next-slice
  send_and_wait '\r' 'command=none.*grain=row' flat-enter-row
  send_and_wait 'j' 'command=move-diff-row:1' flat-next-row
  send_and_wait '\033' 'command=none.*grain=hunk' flat-leave-row
  send_and_wait '\033' 'command=none screen=flat-files' leave-flat-diff
  send_and_wait 'F' 'command=none screen=walk' leave-flat-files
  quit_review navigation-quit
}

for width in 80 110 160; do
  log="$OUT_DIR/${width}-navigation.log"
  rm -f "$log"
  export PROBE_OUT="$log"
  export PROBE_SCENARIO=reader-parity
  unset PROBE_SCREEN
  drive_navigation | probe "$width" "$OUT_DIR/${width}-navigation.capture" >/dev/null 2>&1

  grep -q "BOOT app=ReviewApp scenario=reader-parity width=$width" "$log"
  ! grep -q '^TIMEOUT' "$log"                                    # the app exited on q
  grep -q 'command=none.*target=1' "$log"                        # ) cycled location
  grep -q 'command=select-range' "$log"                          # v preserved
  grep -q 'command=expand-hidden:next' "$log"                    # z preserved
  grep -q 'command=expand-hidden:file' "$log"                    # Z preserved
  # Paging in BOTH directions — the command name must carry its direction, or a
  # missing page-down is unobservable.
  grep -q 'command=page:up:half' "$log"                          # u
  grep -q 'command=page:up:full' "$log"                          # b
  grep -q 'command=page:down:half' "$log"                        # D
  grep -q 'command=page:down:full' "$log"                        # f
  grep -q 'command=scroll-diff-edge:top' "$log"                  # g
  grep -q 'command=scroll-diff-edge:bottom' "$log"               # G
  grep -q 'command=recenter-diff' "$log"                          # C-l
  grep -q 'command=move-diff-file:1' "$log"                      # .
  grep -q 'command=move-diff-file:-1' "$log"                     # ,
  grep -q 'screen=flat-files' "$log"                             # F escape hatch
  grep -q '^STATE screen=walk .*hunk=hunk_story_owned_p1' "$log" # Enter reaches the owning Part
  grep -q 'command=move-diff-slice:1' "$log"                    # default movement is slice-grain
  grep -q 'command=move-diff-row:1' "$log"                       # Enter descends to row-grain
  grep -q 'grain=hunk hunk=hunk_story_same_part' "$log"          # selected retained hunk advances
  grep -q 'grain=row' "$log"                                     # explicit row-grain state is visible
  grep -q 'command=refresh' "$log"                               # R
  grep -q 'screen=comments' "$log"                               # C
  grep -q 'command=help' "$log"                                  # ?

  # Every scenario must boot and survive a real terminal at this width. Content
  # is asserted against the real rendered frame in reviewApp.render.test.tsx.
  for scenario in sole-part mixed-parts unplaced-item unassigned unassigned-floor-only uncertainty-floor-only comments no-narrative two-checkpoints attention-rich; do
    scenario_log="$OUT_DIR/${width}-${scenario}.log"
    rm -f "$scenario_log"
    export PROBE_OUT="$scenario_log"
    export PROBE_SCENARIO="$scenario"
    # `walk` belongs to a current Story Part. Floor-only fixtures start on their
    # deterministic screen, so ask for the route each scenario can actually own.
    case "$scenario" in
      mixed-parts) export PROBE_SCREEN=brief ;;
      unassigned | unassigned-floor-only) export PROBE_SCREEN=unassigned ;;
      comments) export PROBE_SCREEN=comments ;;
      no-narrative | two-checkpoints | uncertainty-floor-only) export PROBE_SCREEN=brief ;;
      *) export PROBE_SCREEN=walk ;;
    esac
    {
      wait_ready "$scenario_log"
      if [[ "$scenario" == "unassigned" || "$scenario" == "unassigned-floor-only" ]]; then
        send_and_wait '\r' 'command=none.*grain=row' unassigned-enter-row
        send_and_wait 'j' 'command=move-diff-row:1' unassigned-next-row
        send_and_wait '\033' 'command=none.*grain=hunk' unassigned-leave-row
        send_and_wait 'j' 'command=move-diff-slice:1' unassigned-next-slice
        send_and_wait 'm' 'command=mark-inspected' unassigned-mark
      fi
      if [[ "$scenario" == "no-narrative" ]]; then
        send_and_wait '\r' 'command=activate screen=brief' floor-open
        send_and_wait 'j' 'command=move-diff-slice:1' floor-next-slice
        send_and_wait '\033[C' 'command=none.*grain=row' floor-right-enter-row
        send_and_wait 'j' 'command=move-diff-row:1' floor-next-row
        send_and_wait '\033[D' 'command=none.*grain=hunk' floor-left-return-slice
        send_and_wait 'j' 'command=move-diff-slice:1' floor-next-hunk
      fi
      if [[ "$scenario" == "uncertainty-floor-only" ]]; then
        send_and_wait '\r' 'command=activate screen=brief' uncertainty-open
        send_and_wait '\t' 'command=none.*focus=rail' uncertainty-focus-rail
        send_and_wait 'j' 'command=none.*context=1' uncertainty-next-item
      fi
      if [[ "$scenario" == "two-checkpoints" ]]; then
        send_and_wait '\r' 'command=activate screen=brief' checkpoint-open
        send_and_wait ']' 'command=move-page:1' checkpoint-next-page
        send_and_wait 'j' 'command=move-diff-slice:1' checkpoint-next-slice
        send_and_wait '[' 'command=move-page:-1' checkpoint-previous-page
        send_and_wait 'j' 'command=move-diff-slice:1' checkpoint-previous-slice
      fi
      quit_review scenario-quit
    } | probe "$width" "$OUT_DIR/${width}-${scenario}.capture" >/dev/null 2>&1

    grep -q "BOOT app=ReviewApp scenario=${scenario} width=${width}" "$scenario_log"
    ! grep -q '^TIMEOUT' "$scenario_log"
  done

  grep -q 'screen=unassigned' "$OUT_DIR/${width}-unassigned.log"
  # The deterministic lens reaches unexplained code, descends to rows in place,
  # and records the selected slice as inspected.
  grep -q 'screen=unassigned' "$OUT_DIR/${width}-unassigned-floor-only.log"
  grep -q 'command=mark-inspected' "$OUT_DIR/${width}-unassigned-floor-only.log"
  grep -q 'grain=hunk hunk=hunk_fixture_second' "$OUT_DIR/${width}-no-narrative.log"
  grep -q 'grain=row hunk=hunk_fixture_second' "$OUT_DIR/${width}-no-narrative.log"
  grep -q 'grain=hunk hunk=hunk_fixture_third' "$OUT_DIR/${width}-no-narrative.log"
  grep -q 'screen=floor-diff.*focus=rail.*context=1' "$OUT_DIR/${width}-uncertainty-floor-only.log"
  grep -q 'command=move-page:1' "$OUT_DIR/${width}-two-checkpoints.log"
  grep -q 'command=move-page:-1' "$OUT_DIR/${width}-two-checkpoints.log"

  # Warning glyphs cross the renderer/terminal width boundary. U+26A0 was
  # measured as two cells by OpenTUI and one by real terminals, so the skipped
  # continuation cell retained one character from the diff after returning to
  # Brief. Exercise that exact transition and reject ambiguous-width output.
  export PROBE_OUT="$OUT_DIR/${width}-brief-warning-repaint.log"
  rm -f "$PROBE_OUT"
  export PROBE_SCENARIO=no-narrative
  export PROBE_SCREEN=brief
  export PROBE_WARNINGS=1
  {
    wait_ready "$PROBE_OUT"
    send_and_wait '\r' 'command=activate screen=brief' warning-open
    send_and_wait '\033' 'command=none screen=brief' warning-back
    quit_review warning-quit
  } |
    probe "$width" "$OUT_DIR/${width}-brief-warning-repaint.capture" >/dev/null 2>&1
  grep -q 'STATE screen=floor-diff' "$OUT_DIR/${width}-brief-warning-repaint.log"
  grep -q 'STATE screen=brief' "$OUT_DIR/${width}-brief-warning-repaint.log"
  ! grep -q '⚠' "$OUT_DIR/${width}-brief-warning-repaint.capture"
  unset PROBE_WARNINGS

  export PROBE_OUT="$OUT_DIR/${width}-finish-complete.log"
  rm -f "$PROBE_OUT"
  export PROBE_SCENARIO=complete
  unset PROBE_SCREEN
  {
    wait_ready "$PROBE_OUT"
    send_and_wait 'j' 'command=move-list:1 screen=brief' finish-select
    send_and_wait '\r' '^STATE screen=finish' finish-open
    send_and_wait '\r' 'command=finish-complete' finish-complete
    wait_for_log_count "$PROBE_OUT" '^JOURNAL action=COMPLETE' 1 finish-complete-journal
    send_and_wait 'r' 'command=resume' finish-reopen
    wait_for_log_count "$PROBE_OUT" '^JOURNAL action=REOPEN' 1 finish-reopen-journal
    quit_review finish-quit
  } |
    probe "$width" "$OUT_DIR/${width}-finish-complete.capture" >/dev/null 2>&1
  grep -q 'screen=finish' "$OUT_DIR/${width}-finish-complete.log"
  grep -q 'command=finish-complete' "$OUT_DIR/${width}-finish-complete.log"
  grep -q 'JOURNAL action=COMPLETE state=COMPLETE history=1' "$OUT_DIR/${width}-finish-complete.log"
  grep -q 'JOURNAL action=REOPEN state=OPEN history=2' "$OUT_DIR/${width}-finish-complete.log"

  export PROBE_OUT="$OUT_DIR/${width}-finish-partial.log"
  rm -f "$PROBE_OUT"
  export PROBE_SCENARIO=sole-part
  unset PROBE_SCREEN
  {
    wait_ready "$PROBE_OUT"
    send_and_wait 'j' 'command=move-list:1 screen=brief' finish-partial-select
    send_and_wait '\r' '^STATE screen=finish' finish-partial-open
    send_and_wait 'p' 'command=finish-partial' finish-partial-action
    printf 'remaining work\023'
    wait_for_log_count "$PROBE_OUT" '^JOURNAL action=PARTIAL' 1 finish-partial-journal
    quit_review finish-partial-quit
  } |
    probe "$width" "$OUT_DIR/${width}-finish-partial.capture" >/dev/null 2>&1
  grep -q 'screen=finish' "$OUT_DIR/${width}-finish-partial.log"
  grep -q 'command=finish-partial' "$OUT_DIR/${width}-finish-partial.log"
  grep -q 'JOURNAL action=PARTIAL state=PARTIAL history=1' "$OUT_DIR/${width}-finish-partial.log"

  export PROBE_OUT="$OUT_DIR/${width}-app-journey.log"
  rm -f "$PROBE_OUT"
  unset PROBE_SCENARIO PROBE_SCREEN PROBE_WARNINGS PROBE_DIFF
  export PROBE_TIMEOUT_MS=30000
  drive_app_journey |
    app_probe "$width" "$OUT_DIR/${width}-app-journey.capture" >/dev/null 2>&1
  grep -q "BOOT app=App scenario=watch-review width=$width" "$PROBE_OUT"
  [[ $(log_count "$PROBE_OUT" '^ROUTE mode=review') -ge 2 ]]
  [[ $(log_count "$PROBE_OUT" '^ROUTE mode=watch') -ge 3 ]]
  grep -q '^APP_OVERLAY help=open' "$PROBE_OUT"
  grep -q '^LENSES checkpoints=✓ Checkpoints' "$PROBE_OUT"
  grep -q '^LENSES checkpoints=Checkpoints story=✓ Story' "$PROBE_OUT"
  grep -q '^WATCH_DETAIL level=task$' "$PROBE_OUT"
  grep -q '^WATCH_DETAIL level=thread$' "$PROBE_OUT"
  grep -q '^WATCH_PANE value=rail$' "$PROBE_OUT"
  grep -q '^REVIEW_STATE screen=floor-diff depth=3 ' "$PROBE_OUT"
  grep -q '^REVIEW_STATE screen=comments depth=2 ' "$PROBE_OUT"
  grep -q '^REVIEW_STATE screen=floor-diff depth=1 ' "$PROBE_OUT"
  grep -q '^REVIEW_STATE screen=brief depth=0 ' "$PROBE_OUT"
  ! grep -q '^TIMEOUT' "$PROBE_OUT"
done

# One production-shaped pointer journey is intentionally taller than the width
# matrix above. It uses actual xterm SGR input against the real ReviewApp nodes:
# motion/hover, horizontal wheel, native scrollbar drag, file selection, and the
# shared modal actions all cross the CLI renderer's protocol parser.
export PROBE_OUT="$OUT_DIR/160-pointer-journey.log"
rm -f "$PROBE_OUT"
export PROBE_SCENARIO=no-narrative
export PROBE_SCREEN=floor-diff
export PROBE_DIFF=tall-two-file
export PROBE_TIMEOUT_MS=30000
{
  wait_ready "$PROBE_OUT"
  wait_for_node "$PROBE_OUT" review-diff-scroll
  wait_for_node "$PROBE_OUT" review-file-navigator-row-1

  # Motion alone must reach the second file row and paint a hover background.
  expected=$(( $(log_count "$PROBE_OUT" '^NODE id=review-file-navigator-row-1 present=1 .* alpha=[1-9]') + 1 ))
  mouse_node_point "$PROBE_OUT" review-file-navigator-row-1 move
  wait_for_log_count "$PROBE_OUT" '^NODE id=review-file-navigator-row-1 present=1 .* alpha=[1-9]' "$expected" pointer-hover

  # Native horizontal-wheel directions share the controller's bounded pan.
  mouse_wheel_node "$PROBE_OUT" review-diff-scroll 67
  wait_for_log_count "$PROBE_OUT" '^STATE .* offset=4 ' 1 horizontal-wheel-right
  expected=$(( $(log_count "$PROBE_OUT" '^STATE .* offset=0 ') + 1 ))
  mouse_wheel_node "$PROBE_OUT" review-diff-scroll 66
  wait_for_log_count "$PROBE_OUT" '^STATE .* offset=0 ' "$expected" horizontal-wheel-left

  # Drag the real ScrollBox slider; viewport, sticky title, and file rail must
  # publish the second file while the semantic cursor stays on the first hunk.
  mouse_drag_scrollbar_to_bottom "$PROBE_OUT" review-diff-scroll
  wait_for_log_count "$PROBE_OUT" '^VIEWPORT top=[1-9][0-9][0-9]+ .*header=.*src/second[.]ts.* hunk=hunk_fixture ' 1 pointer-native-drag
  wait_for_log_count "$PROBE_OUT" '^VIEWPORT .*files=.*• M fixture[.]ts.*▌ M second[.]ts' 1 pointer-file-sync

  # Reset only the viewport, then select file two through its real pointer row.
  expected=$(( $(log_count "$PROBE_OUT" '^VIEWPORT top=0 ') + 1 ))
  send_and_wait 'g' 'command=scroll-diff-edge:top' pointer-reset-top
  wait_for_log_count "$PROBE_OUT" '^VIEWPORT top=0 ' "$expected" pointer-top-restored
  expected=$(( $(log_count "$PROBE_OUT" '^VIEWPORT .*header=.*src/second[.]ts') + 1 ))
  mouse_node_point "$PROBE_OUT" review-file-navigator-row-1 click
  wait_for_log_count "$PROBE_OUT" '^STATE .*hunk=hunk_fixture_third .*' 1 pointer-file-select
  wait_for_log_count "$PROBE_OUT" '^VIEWPORT .*header=.*src/second[.]ts' "$expected" pointer-file-header

  # The retained reader stays mounted while raw pointer down/up activates Save
  # and Cancel in the shared composer chrome.
  send_and_wait 'c' 'command=comment' pointer-comment-open
  wait_for_log_count "$PROBE_OUT" '^OVERLAY input=open' 1 pointer-comment-modal
  printf 'pty pointer comment'
  sleep 0.2
  expected=$(( $(log_count "$PROBE_OUT" '^OVERLAY input=closed') + 1 ))
  mouse_node_point "$PROBE_OUT" review-input-modal-action-save click
  wait_for_log_count "$PROBE_OUT" '^OVERLAY input=closed' "$expected" pointer-comment-save
  wait_for_log_count "$PROBE_OUT" '^STATE .*notice=Comment filed$' 1 pointer-comment-filed

  send_and_wait 'c' 'command=comment' pointer-comment-reopen
  wait_for_log_count "$PROBE_OUT" '^OVERLAY input=open' 2 pointer-comment-modal-again
  expected=$(( $(log_count "$PROBE_OUT" '^OVERLAY input=closed') + 1 ))
  mouse_node_point "$PROBE_OUT" review-input-modal-action-cancel click
  wait_for_log_count "$PROBE_OUT" '^OVERLAY input=closed' "$expected" pointer-comment-cancel
  quit_review pointer-quit
} | probe 160 "$OUT_DIR/160-pointer-journey.capture" >/dev/null 2>&1

grep -q '^STATE .* offset=4 ' "$PROBE_OUT"
grep -Eq '^VIEWPORT top=[1-9][0-9][0-9]+ .*header=.*src/second[.]ts' "$PROBE_OUT"
grep -q '^STATE .*notice=Comment filed$' "$PROBE_OUT"
[[ $(log_count "$PROBE_OUT" '^OVERLAY input=open') -ge 2 ]]
[[ $(log_count "$PROBE_OUT" '^OVERLAY input=closed') -ge 2 ]]
! grep -q '^TIMEOUT' "$PROBE_OUT"

echo "review-experience PTY: whole-App keyboard/mouse at 80/110/160 passed ($OUT_DIR)"
