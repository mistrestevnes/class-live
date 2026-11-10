# Freezing a sim from Class Live

When the teacher clicks Pause students or sends a question, Class Live covers each student's
screen and sends the sim a message: `{ classlive: "pause" }`, then `{ classlive: "resume" }`.

A sim freezes only if it listens for that message. To make a sim listen, paste the contents of
`classlive-freeze.js` into the sim's HTML file at the very top of `<head>`:

    <script>
    ...contents of classlive-freeze.js...
    </script>

It must come before the sim's own scripts. No other change is needed for sims that animate with
requestAnimationFrame (almost all canvas sims). Sims without it still get covered; they just keep
running underneath.
