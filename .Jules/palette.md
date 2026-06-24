## 2026-06-24 - Interactive Element Focus Feedback
**Learning:** While testing keyboard navigation, I noticed that interactive elements only triggered their delight animations (like the upload zone lifting, or buttons scaling) on mouse `:hover`. Keyboard users missed out on this tactile feedback when using tab navigation.
**Action:** Always pair `:hover` selectors with `:focus-visible` for interaction animations, and provide a clear baseline outline (e.g. `outline: 2px dashed var(--rust);`) for elements that lack explicit active state backgrounds.
