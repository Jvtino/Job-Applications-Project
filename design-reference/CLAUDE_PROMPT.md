Use the attached Sunrise UI files as the visual interface for my job application automation app.

Files included:
- `sunrise-ui.html`
- `shared.css`
- `shared.js`
- `assets/jobflow-artwork.png`

App purpose:
This app automates job applications. A user uploads a resume, the app searches the web for matching jobs, ranks them, auto-applies to safe matches, moves uncertain matches into a one-click review queue, and tracks completed applications in an Applied section.

What I want you to do:
1. Incorporate the Sunrise UI into the app you are building.
2. Keep the interface automation-first. The main experience should prioritize:
   - Automated applications
   - One-click applications that only need my approval
   - Applied tracker for completed applications
   - Automation rules and safety checks
3. Preserve the look and feel:
   - Bright, warm, polished dashboard
   - Light brown/caramel base colors
   - Coral, teal, yellow, sky blue accents
   - Rounded but professional panels
   - Dense command-center layout, not a landing page
4. Convert the HTML into the app’s framework/components if needed.
5. Reuse the CSS variables and component styling from `shared.css` as the design system.
6. Recreate or adapt the interactions from `shared.js`:
   - Toasts
   - Application detail drawer
   - One-click review modal
   - Toggle/save/demo button states
7. Wire the UI to real app data:
   - Replace mock companies and roles with jobs found by the app
   - Replace fit scores with real resume/job match scores
   - Replace automation metrics with real run stats
   - Move submitted jobs into the Applied tracker
   - Move jobs needing approval into the one-click queue
   - Use the detail drawer to show job match reasoning, resume changes, form answers, and safety checks
8. Keep these major sections:
   - Left navigation: Automated, One-click, Applied, Rules
   - Header actions: Rules, Run automation, notifications
   - Automation hero
   - One-click queue
   - Progress dashboard
   - Automated applications
   - Preflight safety
   - Applied tracker CRM
   - Automation rules builder
   - Semi-automated packet
   - Automation coverage
   - Automation log
   - Application detail drawer
   - One-click review modal
9. Remove anything that is only for demo navigation. The real app should not show demo-switcher links.
10. Make it responsive for desktop and mobile.

Important behavior:
- Auto-apply should only happen when a job passes the user’s rules.
- Jobs that need subjective approval should go to the one-click queue.
- Every completed application should appear in Applied.
- The user should always be able to inspect what will be sent before approving a one-click application.
- The automation log should explain what the app did and why.

Please integrate this UI carefully and keep the final product feeling like the attached Sunrise design.
