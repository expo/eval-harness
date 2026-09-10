#!/usr/bin/env bash
# Package one canonical artifact directory and optionally mirror that exact
# archive to GCS. The GCS path is deliberately best-effort.
set -euo pipefail

PACKAGE_SA_FILE=""
PACKAGE_GAC_OWNED=0
PACKAGE_PREVIOUS_GAC=""
PACKAGE_PREVIOUS_GAC_SET=0

package::cleanup() {
  if [ -n "$PACKAGE_SA_FILE" ]; then
    rm -f -- "$PACKAGE_SA_FILE"
  fi
  if [ "$PACKAGE_GAC_OWNED" = 1 ]; then
    if [ "$PACKAGE_PREVIOUS_GAC_SET" = 1 ]; then
      export GOOGLE_APPLICATION_CREDENTIALS="$PACKAGE_PREVIOUS_GAC"
    else
      unset GOOGLE_APPLICATION_CREDENTIALS
    fi
  fi
  PACKAGE_SA_FILE=""
  PACKAGE_GAC_OWNED=0
  PACKAGE_PREVIOUS_GAC=""
  PACKAGE_PREVIOUS_GAC_SET=0
}

package::artifact() { # source_dir archive_path gcs_object_name
  local source_dir="$1" archive_path="$2" gcs_object_name="$3"
  local source_abs archive_parent archive_abs gcs_log pushed

  if [ ! -d "$source_dir" ]; then
    echo "artifact source directory does not exist: $source_dir" >&2
    return 2
  fi
  if [ -z "$archive_path" ] || [ -z "$gcs_object_name" ]; then
    echo "archive path and GCS object name must be non-empty" >&2
    return 2
  fi

  source_abs="$(cd "$source_dir" && pwd -P)" || return 2
  if [ "$source_abs" = / ]; then
    echo "refusing unsafe artifact source: $source_dir" >&2
    return 2
  fi
  archive_parent="$(dirname "$archive_path")"
  mkdir -p "$archive_parent" || return 2
  archive_parent="$(cd "$archive_parent" && pwd -P)" || return 2
  archive_abs="$archive_parent/$(basename "$archive_path")"
  case "$archive_abs" in
    "$source_abs"/*)
      echo "archive must be outside its source directory: $archive_abs" >&2
      return 2
      ;;
  esac

  tar -czf "$archive_abs" -C "$source_abs" . || return $?
  echo "  archive: $archive_abs ($(wc -c < "$archive_abs" | tr -d ' ') bytes)"

  if [ -z "${GCS_BUCKET:-}" ]; then
    echo "  GCS mirror skipped (GCS_BUCKET unset)"
    return 0
  fi

  gcs_log="$archive_parent/package-gcs.log"
  PACKAGE_SA_FILE=""
  if [ -n "${GCP_SA_KEY:-}" ]; then
    PACKAGE_SA_FILE="$(mktemp "$archive_parent/.gcp-sa.XXXXXX")" || return 2
    chmod 600 "$PACKAGE_SA_FILE"
    printf '%s' "$GCP_SA_KEY" > "$PACKAGE_SA_FILE"
    if [ "${GOOGLE_APPLICATION_CREDENTIALS+x}" = x ]; then
      PACKAGE_PREVIOUS_GAC_SET=1
      PACKAGE_PREVIOUS_GAC="$GOOGLE_APPLICATION_CREDENTIALS"
    fi
    PACKAGE_GAC_OWNED=1
    export GOOGLE_APPLICATION_CREDENTIALS="$PACKAGE_SA_FILE"
  fi

  pushed=1
  if command -v gcloud >/dev/null 2>&1; then
    if [ -n "$PACKAGE_SA_FILE" ]; then
      gcloud auth activate-service-account --key-file="$PACKAGE_SA_FILE" >>"$gcs_log" 2>&1 || true
    fi
    gcloud storage cp "$archive_abs" "gs://$GCS_BUCKET/$gcs_object_name" >>"$gcs_log" 2>&1 && pushed=0
  elif command -v gsutil >/dev/null 2>&1; then
    gsutil cp "$archive_abs" "gs://$GCS_BUCKET/$gcs_object_name" >>"$gcs_log" 2>&1 && pushed=0
  else
    echo "  ⚠️  neither gcloud nor gsutil is available; skipping GCS mirror"
  fi
  package::cleanup

  if [ "$pushed" = 0 ]; then
    echo "  ✅ mirrored gs://$GCS_BUCKET/$gcs_object_name"
  else
    echo "  ⚠️  GCS mirror failed (see $gcs_log); EAS archive remains available"
  fi
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -ne 3 ]; then
    echo "usage: $0 <source_dir> <archive_path> <gcs_object_name>" >&2
    exit 2
  fi
  trap package::cleanup EXIT
  trap 'package::cleanup; exit 130' HUP INT TERM
  package::artifact "$1" "$2" "$3"
fi
