#!/usr/bin/env bash
# Fails on purpose: the dry run stops at the provider's authentication error,
# so a run that reached this script would mean the fences or the key handling
# let the agent act, and the failure makes that visible.
echo "the fixture's tests are meant to fail"
exit 1
