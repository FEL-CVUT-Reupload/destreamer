#!/usr/bin/env bash
NODE_EXEC=${NODE_EXEC:-"node"}
NODE_VERSION=$($NODE_EXEC --version)

if [[ $NODE_VERSION == "v8."* ]]; then
    $NODE_EXEC build/src/destreamer.js "$@"
else
    $NODE_EXEC --max-http-header-size 32768 build/src/destreamer.js "$@"
fi
