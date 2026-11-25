import assert from 'node:assert/strict'
import test from 'node:test'
import { workoutFocus } from './workoutFocus.ts'

test('the workout name decides when it names a focus', () => {
  assert.equal(workoutFocus('Leg day', ['Barbell Squat', 'Dumbbell Bicep Curl']), 'legs')
  assert.equal(workoutFocus('Pull day', ['Romanian Deadlift', 'Lat Pulldown']), 'pull')
})

test('the exercises decide when the name says nothing', () => {
  assert.equal(workoutFocus('Monday', ['Seated Cable Row', 'Face Pull', 'Barbell Squat']), 'pull')
  assert.equal(workoutFocus('Session A', ['Walking Lunge', 'Leg Press', 'Lat Pulldown']), 'legs')
})

test('push, full body and unknown workouts use the upper-body photo', () => {
  assert.equal(workoutFocus('Push day', ['Bench Press', 'Overhead Press']), 'upper')
  assert.equal(workoutFocus('Empty workout'), 'upper')
})
