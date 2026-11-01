// Executed by the machine's existing bash via InstaBox /exec, never inside Workers.
// All variable input is passed as argv elements. No eval, sudo, or installed service.
export const uploadScript = String.raw`set -Eeuo pipefail
action=$1; target=$2; upload_id=$3; guard=$4; total=$5; chunk=$6
index=@@{7:-0}; nonce=@@{8:-}; digest=@@{9:-}; overwrite=@@{10:-false}; parents=@@{11:-false}
fail() { printf 'PANEL_UPLOAD_V1 %s\nERROR %s\nEND\n' "$guard" "$1"; exit 1; }
for tool in cat sha256sum stat flock base64 realpath mv ln chmod mkdir rm rmdir sync; do command -v "$tool" >/dev/null || fail multipart_tools_missing; done
[[ "$upload_id" =~ ^[0-9a-f-]{36}$ && "$guard" =~ ^[0-9a-f]{64}$ && "$total" =~ ^[0-9]+$ && "$chunk" =~ ^[0-9]+$ ]] || fail invalid_upload
[[ "$target" == /* && "$target" != / && "$target" != *$'\n'* && "$total" -gt 0 && "$total" -le 21474836480 && "$chunk" -gt 0 && "$chunk" -le 16777216 ]] || fail invalid_upload
parent=@@{target%/*}; [[ -n "$parent" ]] || parent=/; name=@@{target##*/}
if [[ "$action" == init && "$parents" == true ]]; then mkdir -p -- "$parent" || fail upload_permission; fi
resolved=$(realpath -e -- "$parent") || fail missing_parent
[[ -d "$resolved" ]] || fail missing_parent
if [[ "$action" != init && "$resolved" != "$parent" ]]; then fail upload_directory_changed; fi
parent=$resolved; target="@@{parent%/}/$name"; dir="@@{parent%/}/.instabox-upload-$upload_id"
count=$(( (total + chunk - 1) / chunk ))
[[ ! -L "$dir" ]] || fail invalid_upload
if [[ "$action" == cleanup && ! -e "$dir" ]]; then exit 0; fi
if [[ "$action" == init ]]; then
  if [[ ! -d "$dir" ]]; then
    [[ ! -L "$target" && ! -d "$target" ]] || fail not_a_file
    [[ "$overwrite" == true || ! -e "$target" ]] || fail file_exists
    (umask 077; mkdir -- "$dir") || [[ -d "$dir" ]] || fail upload_permission
  fi
fi
if [[ ! -d "$dir" ]]; then [[ "$action" == cleanup ]] && exit 0; fail upload_missing; fi
[[ ! -L "$dir/lock" && ! -L "$dir/meta" && ! -L "$dir/state" && ! -L "$dir/result" ]] || fail invalid_upload
exec 9>>"$dir/lock"
atomic() { local file=$1; shift; printf '%s\n' "$@" >"$file.tmp"; mv -fT -- "$file.tmp" "$file"; }
verify_meta() {
  if [[ ! -f "$dir/meta" ]]; then
    [[ "$action" == cleanup && ! -L "$dir" ]] || fail upload_missing
    shopt -s nullglob dotglob
    for entry in "$dir"/*; do
      file=@@{entry##*/}
      [[ ! -d "$entry" && ( "$file" =~ ^(part|hash)-[0-9]+(\.tmp)?$ || "$file" =~ ^incoming-[0-9a-f-]{36}$ || "$file" =~ ^(lock|meta|state|error|result|ready|assembled)(\.tmp)?$ ) ]] || fail upload_cleanup_refused
    done
    return
  fi
  mapfile -t meta <"$dir/meta"
  [[ @@{meta[0]:-} == "$guard" && @@{meta[1]:-} == "$total" && @@{meta[2]:-} == "$chunk" && @@{meta[3]:-} == "$target" && @@{meta[4]:-} == "$(stat -c '%d:%i' -- "$parent")" ]] || fail upload_directory_changed
}
state_output() {
  printf 'PANEL_UPLOAD_V1 %s\nPATH %s\nSTATE %s\n' "$guard" "$(printf %s "$target" | base64 -w0)" "$(cat -- "$dir/state")"
  local i hash
  for ((i=0; i<count; i++)); do
    if [[ -f "$dir/hash-$i" && ! -L "$dir/hash-$i" ]]; then read -r hash <"$dir/hash-$i"; printf 'PART %s %s\n' "$i" "$hash"; fi
  done
  if [[ -f "$dir/result" ]]; then printf 'RESULT %s\n' "$(cat -- "$dir/result")"; fi
  if [[ -f "$dir/error" ]]; then printf 'ERROR %s\n' "$(cat -- "$dir/error")"; fi
  printf 'END\n'
}
if [[ "$action" == status ]] && ! flock -n 9; then
  verify_meta
  [[ -f "$dir/state" && $(cat -- "$dir/state") == merging ]] || fail upload_busy
  state_output; exit 0
fi
flock -w 2 9 || fail upload_busy
if [[ "$action" == init && ! -f "$dir/meta" ]]; then
  atomic "$dir/meta" "$guard" "$total" "$chunk" "$target" "$(stat -c '%d:%i' -- "$parent")"
  atomic "$dir/state" uploading
fi
verify_meta
state=$(cat -- "$dir/state" 2>/dev/null || true)
# A dead merge releases flock. A later retry can reconstruct the assembled file.
if [[ "$state" == merging ]]; then atomic "$dir/state" failed; atomic "$dir/error" assembly_interrupted; state=failed; fi
case "$action" in
  init|status) state_output ;;
  prepare|accept)
    [[ "$state" == uploading || "$state" == failed ]] || fail upload_closed
    [[ "$index" =~ ^(0|[1-9][0-9]{0,4})$ && "$index" -lt "$count" && "$nonce" =~ ^[0-9a-f-]{36}$ && "$digest" =~ ^[0-9a-f]{64}$ ]] || fail invalid_upload
    incoming="$dir/incoming-$nonce"; part="$dir/part-$index"; receipt="$dir/hash-$index"
    [[ ! -L "$incoming" && ! -L "$part" && ! -L "$receipt" ]] || fail invalid_upload
    if [[ -f "$receipt" ]]; then read -r old <"$receipt"; [[ "$old" == "$digest" ]] || fail upload_part_conflict; fi
    if [[ "$action" == accept ]]; then
      expected=$chunk; (( index == count-1 )) && expected=$((total-index*chunk))
      [[ -f "$incoming" && $(stat -c %s -- "$incoming") == "$expected" ]] || fail upload_part_invalid
      actual=$(sha256sum -- "$incoming"); actual=@@{actual%% *}
      [[ "$actual" == "$digest" ]] || fail upload_part_invalid
      # Accepted chunks are immutable: a retry may only replace identical bytes.
      mv -fT -- "$incoming" "$part"; atomic "$receipt" "$digest"
      atomic "$dir/state" uploading; rm -f -- "$dir/error"
    fi
    state_output ;;
  finish)
    if [[ "$state" == complete ]]; then state_output; exit 0; fi
    for ((i=0; i<count; i++)); do [[ -f "$dir/part-$i" && ! -L "$dir/part-$i" && -f "$dir/hash-$i" && ! -L "$dir/hash-$i" ]] || fail upload_incomplete; done
    [[ ! -L "$dir/assembled" && ! -L "$dir/ready" ]] || fail invalid_upload
    # Files inside the private session directory are owned by this upload only.
    merge_job() (
      trap '' HUP
      code=assembly_failed
      trap 'status=$?; if [[ $status -ne 0 ]]; then atomic "$dir/error" "$code"; atomic "$dir/state" failed; fi' EXIT
      recover=false
      if [[ -f "$dir/ready" ]]; then
        read -r ready_size ready_hash ready_mode ready_created ready_inode <"$dir/ready"
        if [[ -f "$target" && ! -L "$target" && $(stat -c '%d:%i' -- "$target") == "$ready_inode" ]]; then
          check=$(sha256sum -- "$target"); check=@@{check%% *}
          [[ "$check" == "$ready_hash" ]] && recover=true
        fi
      fi
      if [[ "$recover" != true ]]; then
        : >"$dir/assembled"
        for ((i=0; i<count; i++)); do
          part="$dir/part-$i"; expected=$chunk; (( i == count-1 )) && expected=$((total-i*chunk))
          code=upload_part_invalid
          [[ ! -L "$part" && $(stat -c %s -- "$part") == "$expected" ]]
          read -r want <"$dir/hash-$i"; got=$(sha256sum -- "$part"); got=@@{got%% *}; [[ "$want" == "$got" ]]
          code=assembly_failed; cat -- "$part" >>"$dir/assembled"
        done
        [[ $(stat -c %s -- "$dir/assembled") == "$total" ]]
        full=$(sha256sum -- "$dir/assembled"); full=@@{full%% *}
        mode=644; created=true
        code=not_a_file; [[ ! -L "$target" && ! -d "$target" ]]
        if [[ -e "$target" ]]; then
          code=file_exists; [[ "$overwrite" == true ]]
          code=upload_permission; [[ -w "$target" ]]; mode=$(stat -c %a -- "$target"); created=false
        fi
        chmod "$mode" -- "$dir/assembled"; sync -f -- "$dir/assembled"
        inode=$(stat -c '%d:%i' -- "$dir/assembled")
        atomic "$dir/ready" "$total $full $mode $created $inode"
        code=upload_directory_changed
        [[ $(realpath -e -- "$parent") == "$parent" && $(stat -c '%d:%i' -- "$parent") == "@@{meta[4]}" ]]
        if [[ "$overwrite" == true ]]; then
          code=assembly_failed; mv -fT -- "$dir/assembled" "$target"
        else
          # Same-filesystem hard-link publication is atomic and never clobbers.
          if ! ln -T -- "$dir/assembled" "$target"; then
            code=assembly_failed; if [[ -e "$target" || -L "$target" ]]; then code=file_exists; fi; exit 1
          fi
        fi
        read -r ready_size ready_hash ready_mode ready_created ready_inode <"$dir/ready"
      fi
      atomic "$dir/result" "$ready_size $ready_hash $ready_mode $ready_created"
      atomic "$dir/state" complete
      trap - EXIT
      rm -f -- "$dir/error" "$dir/assembled"
      for ((i=0; i<count; i++)); do rm -f -- "$dir/part-$i"; done
    )
    atomic "$dir/state" merging; rm -f -- "$dir/error"
    # The child inherits flock and closes all output, so /exec returns immediately.
    merge_job </dev/null >/dev/null 2>&1 &
    printf 'PANEL_UPLOAD_V1 %s\nPATH %s\nSTATE merging\nEND\n' "$guard" "$(printf %s "$target" | base64 -w0)" ;;
  cleanup)
    # Never recursively remove an arbitrary directory, even if it was tampered with.
    shopt -s nullglob dotglob
    for entry in "$dir"/*; do
      file=@@{entry##*/}
      [[ ! -d "$entry" && ( "$file" =~ ^(part|hash)-[0-9]+(\.tmp)?$ || "$file" =~ ^incoming-[0-9a-f-]{36}$ || "$file" =~ ^(lock|meta|state|error|result|ready|assembled)(\.tmp)?$ ) ]] || fail upload_cleanup_refused
    done
    for entry in "$dir"/*; do
      case "@@{entry##*/}" in meta|state|lock) ;; *) rm -f -- "$entry" ;; esac
    done
    rm -f -- "$dir/state" "$dir/meta"
    exec 9>&-
    rm -f -- "$dir/lock"
    rmdir -- "$dir" ;;
  *) fail invalid_upload ;;
esac
`.replaceAll('@@{', '$' + '{');
