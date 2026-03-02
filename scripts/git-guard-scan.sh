#!/bin/bash
set -euo pipefail

MODE="${1:-pre-commit}"
PUSH_RANGE="${2:-${GIT_GUARD_PUSH_RANGE:-}}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

is_text_candidate() {
  local file="$1"
  case "${file,,}" in
    *.md|*.txt|*.yml|*.yaml|*.json|*.toml|*.ini|*.env|*.ps1|*.sh|*.js|*.ts|*.py|*.rb)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

collect_targets() {
  if [[ "$MODE" == "pre-commit" ]]; then
    git diff --cached --name-only --diff-filter=ACMR | tr -d '\r'
    return
  fi

  if [[ "$MODE" == "pre-push" ]]; then
    if [[ -n "$PUSH_RANGE" ]]; then
      if [[ "$PUSH_RANGE" == *"..."* ]]; then
        git diff --name-only --diff-filter=ACMR "$PUSH_RANGE" | tr -d '\r'
      else
        git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r "$PUSH_RANGE" | tr -d '\r'
      fi
      return
    fi

    if git rev-parse --verify "@{upstream}" >/dev/null 2>&1; then
      git diff --name-only --diff-filter=ACMR "@{upstream}"..HEAD | tr -d '\r'
      return
    fi

    if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
      git diff --name-only --diff-filter=ACMR HEAD~1..HEAD | tr -d '\r'
      return
    fi

    git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r HEAD | tr -d '\r'
    return
  fi

  git ls-files | tr -d '\r'
}

add_finding() {
  FINDINGS+=("$1")
}

scan_path_rules() {
  local file="$1"

  case "$file" in
    HANDOFF.md|ops-local/*|logs/*)
      add_finding "[BLOCKING][local-only] ${file} はローカル運用ファイルのためコミット/プッシュ不可"
      ;;
  esac

  case "${file,,}" in
    .env|.env.*|*.pem|*.p12|*.pfx|*.key|*id_rsa|*id_ed25519)
      add_finding "[BLOCKING][sensitive-file] ${file} は秘匿ファイルのためコミット/プッシュ不可"
      ;;
  esac
}

check_regex() {
  local file="$1"
  local tmp="$2"
  local severity="$3"
  local rule_id="$4"
  local regex="$5"
  local message="$6"

  local hit
  hit="$(grep -nE -- "$regex" "$tmp" | head -n 1 || true)"
  if [[ -n "$hit" ]]; then
    add_finding "[${severity}][${rule_id}] ${file}:${hit} ${message}"
  fi
}

load_target_blob() {
  local file="$1"
  local tmp="$2"

  if [[ "$MODE" == "pre-commit" ]]; then
    git show ":$file" > "$tmp" 2>/dev/null
    return $?
  fi

  if [[ "$MODE" == "pre-push" ]]; then
    git show "HEAD:$file" > "$tmp" 2>/dev/null
    return $?
  fi

  if [[ -f "$file" ]]; then
    cp "$file" "$tmp"
    return 0
  fi

  return 1
}

scan_content_rules() {
  local file="$1"
  local tmp
  tmp="$(mktemp)"

  if ! load_target_blob "$file" "$tmp"; then
    rm -f "$tmp"
    return 0
  fi

  if ! is_text_candidate "$file"; then
    rm -f "$tmp"
    return 0
  fi

  check_regex "$file" "$tmp" "BLOCKING" "openai-key-format" 'sk-[A-Za-z0-9]{20,}' 'OpenAIキー形式を検知'
  check_regex "$file" "$tmp" "BLOCKING" "github-token-format" '(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})' 'GitHubトークン形式を検知'
  check_regex "$file" "$tmp" "BLOCKING" "aws-access-key-format" 'AKIA[0-9A-Z]{16}' 'AWSアクセスキー形式を検知'
  check_regex "$file" "$tmp" "BLOCKING" "slack-token-format" 'xox[baprs]-[A-Za-z0-9-]{10,}' 'Slackトークン形式を検知'
  check_regex "$file" "$tmp" "BLOCKING" "slack-webhook-url" 'https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+' 'Slack Webhook URL を検知'
  check_regex "$file" "$tmp" "BLOCKING" "private-key-material" '-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----' '秘密鍵素材を検知'
  check_regex "$file" "$tmp" "HIGH" "plaintext-credential" '(api[_-]?key|access[_-]?token|secret|password|passwd|pwd)[[:space:]]*[:=][[:space:]]*[^[:space:]#]{8,}' '平文クレデンシャル疑いを検知'
  check_regex "$file" "$tmp" "HIGH" "hardcoded-user-path" '[A-Za-z]:\\Users\\[^\\[:space:]"'"'"']+' 'Windows絶対パスを検知'
  check_regex "$file" "$tmp" "HIGH" "hardcoded-user-path" '/(home|Users)/[^/[:space:]"'"'"']+/' 'Unix系絶対パスを検知'

  local email_hit
  email_hit="$(grep -nE -- '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$tmp" | head -n 1 || true)"
  if [[ -n "$email_hit" ]]; then
    if ! grep -qE -- '@(example\.com|example\.org|example\.net|users\.noreply\.github\.com)\b' <<< "$email_hit"; then
      add_finding "[HIGH][email-address-detected] ${file}:${email_hit} 個人メールアドレス疑いを検知"
    fi
  fi

  rm -f "$tmp"
}

print_block_message() {
  echo "[BLOCK][危険度:BLOCKING][git-guard] 機密情報・個人情報・絶対パス・禁止ファイルを検知したため停止しました。" >&2
  echo "[承認フロー] 自動修正による迂回は禁止です。検知箇所を手動修正後に再実行してください。" >&2
  echo "[承認フロー] --no-verify での回避は禁止です。必ずフックを通過させてください。" >&2
  echo "[検知件数] ${#FINDINGS[@]}" >&2
  local limit=25
  local i=0
  for finding in "${FINDINGS[@]}"; do
    i=$((i + 1))
    if [[ $i -gt $limit ]]; then
      echo "[...省略] 残り $(( ${#FINDINGS[@]} - limit )) 件" >&2
      break
    fi
    echo "- ${finding}" >&2
  done
}

main() {
  mapfile -t TARGETS < <(collect_targets)
  if [[ ${#TARGETS[@]} -eq 0 ]]; then
    echo "GIT_GUARD_SCAN=PASS"
    exit 0
  fi

  FINDINGS=()
  for file in "${TARGETS[@]}"; do
    [[ -z "$file" ]] && continue
    scan_path_rules "$file"
    scan_content_rules "$file"
  done

  if [[ ${#FINDINGS[@]} -gt 0 ]]; then
    print_block_message
    echo "GIT_GUARD_SCAN=FAIL"
    exit 1
  fi

  echo "GIT_GUARD_SCAN=PASS"
  exit 0
}

main "$@"
