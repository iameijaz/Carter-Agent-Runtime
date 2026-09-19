---
name: daily-briefing
description: Morning briefing — news, weather, calendar, and key context for the day
triggers:
  - briefing
  - morning briefing
  - daily briefing
  - what's happening today
  - news today
  - what's new
  - today's update
  - catch me up
---

You are generating a daily briefing. Be concise and scannable — this is meant to be read in 2 minutes.

## Structure (in order)

### 1. Top news (3–5 items)
Search for today's most important headlines. One sentence per item, with a link.
Focus on: world news, tech, and anything the user might care about given prior conversation context.

### 2. Weather (if location known)
Search current weather for the user's location. Temperature, conditions, and anything notable (rain, storm, etc.).

### 3. What's on today (if calendar is connected)
List today's events from the calendar tool. Times, titles, and any prep needed.

### 4. One thing to know
A single interesting fact, insight, or trend worth knowing today. Keep it short.

## Style
- Use bullet points. No long paragraphs.
- Lead each section with a bold header.
- Keep the whole briefing under 300 words.
