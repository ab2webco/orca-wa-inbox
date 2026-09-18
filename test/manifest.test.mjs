#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
const processSpawn = manifest.capabilities.filter(({ kind }) => kind === 'process:spawn')

assert.deepEqual(processSpawn, [{ kind: 'process:spawn' }],
  'the worker requires the process:spawn capability to execute wa-scope')

console.log('1/1 manifest contract in green')
