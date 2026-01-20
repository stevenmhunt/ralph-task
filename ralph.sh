#!/bin/bash
ITERATIONS=${1:-"1"}
TITLE="Ralph Loop"
ralph build $ITERATIONS && notify "$TITLE" "✅ Ralph loop completed successfully" || notify "$TITLE" "❌ Ralph loop had an error!"
