# index.html Code Report

**File:** `index.html`
**Date:** 2026-03-22
**Project:** Workout Tracker PWA

---

## Overview

`index.html` serves as the UI shell of the app. It contains almost no real content — only empty container `<div>`s. All dynamic content (exercise cards, history cards, chips) is injected at runtime by `app.js`. The file is 136 lines long.

---

## Section Breakdown

### 1. `<head>` — Lines 1–13

| Line | Purpose |
|------|---------|
| 4 | Sets UTF-8 character encoding |
| 5 | Mobile-responsive viewport meta tag |
| 6 | PWA: enables standalone mode on iOS |
| 7 | PWA: sets iOS status bar style |
| 8 | PWA: sets app title on iOS home screen |
| 9 | Sets dark theme color for browser chrome |
| 11 | Links to `manifest.json` (PWA configuration) |
| 12 | Links to `style.css` (all styling) |

---

### 2. Header — Lines 18–21

| Line | Purpose |
|------|---------|
| 19 | Displays "💪 Workout" app title |
| 20 | `#header-date` — empty div, filled by JS with today's date on init |

---

### 3. Workout Tab (`#tab-workout`) — Lines 24–56

#### Idle State — Lines 28–35
| Line | Purpose |
|------|---------|
| 34 | "Start Workout" button — calls `startWorkout()` in JS |

#### Active State — Lines 38–53
| Line | Purpose |
|------|---------|
| 38 | Hidden by default (`display:none`), shown by JS when workout starts |
| 40–43 | `#timer-display` — JS updates this every second during a workout |
| 44 | "Finish" button — calls `finishWorkout()` |
| 46 | `#exercises-list` — empty div, JS injects exercise cards here |
| 47 | "+ Add New Exercise" button — calls `openExerciseModal()` |
| 51 | "Cancel Workout" button — calls `cancelWorkout()` |

---

### 4. History Tab (`#tab-history`) — Lines 59–70

| Line | Purpose |
|------|---------|
| 59 | `#tab-history` — hidden by default |
| 63–66 | lbs / kg toggle buttons — call `setUnit()` |
| 68 | `#history-list` — empty div, JS injects past workout cards here |

---

### 5. Tab Bar — Lines 73–89

| Line | Purpose |
|------|---------|
| 74 | "Workout" tab button — has `active` class by default |
| 82 | "History" tab button |
| Both | Call `switchTab()` which toggles visibility of the two tabs |

---

### 6. Add Exercise Modal (`#modal-exercise`) — Lines 93–120

| Line | Purpose |
|------|---------|
| 93 | Bottom sheet popup for adding an exercise |
| 94 | Clicking the overlay background closes it via `onOverlayClick()` |
| 110–113 | Search input — calls `onSearchInput()` on each keystroke |
| 116 | `#chips` — empty div, JS fills with exercise name buttons |
| 117 | "Add Exercise" confirm button — calls `confirmAddExercise()` |

---

### 7. Confirm Modal (`#modal-confirm`) — Lines 122–132

| Line | Purpose |
|------|---------|
| 122 | Generic yes/no confirmation popup, reused across the app |
| 127 | `#confirm-msg` — JS sets the message text dynamically per use case |
| 128 | Confirm button — JS sets its `onclick` dynamically per use case |
| 129 | Cancel button — closes the modal without action |

---

### 8. Script Tag — Line 134

| Line | Purpose |
|------|---------|
| 134 | Loads `app.js` at the bottom of `<body>` so the full DOM is built before JS runs |

---

## Key Patterns

- **Empty containers:** Most `<div>`s have no content — JS populates them at runtime via `innerHTML`
- **Inline event handlers:** Buttons use `onclick="functionName()"` directly in HTML, keeping wiring simple and visible
- **Display toggling:** States and tabs are shown/hidden via `style.display` and CSS classes, not page navigation
- **PWA-ready:** The `<head>` meta tags and `manifest.json` link allow this app to be installed on mobile devices as a native-like app
