# Sim events and commands

A sim talks to Class Live with messages to its parent page.

- Event (sim → Class Live): `parent.postMessage({ classliveEvent: "allAngles" }, "*")`
- Command (Class Live → sim): the sim listens for `e.data.classliveCommand === "unlockZero"`

When a sim is uploaded in the lesson editor, Class Live reads the file and lists what it finds:

1. **The sim's own list.** Put this anywhere in the sim file:

   ```html
   <script type="application/json" id="classlive-events">
   {
     "events":   { "allAngles": "student has run all five angles",
                   "dataSubmitted": "student pressed Submit on the data table" },
     "commands": { "unlockZero": "opens the 0 degree ramp" }
   }
   </script>
   ```

   The text after each name is shown in the question editor's menus.

2. **A scan of the code.** Anything written as `classliveEvent: "name"` or compared with `classliveCommand === "name"`
   is found even if it isn't in the list; it shows as "no description yet".
   Names in the list that the scan can't find are marked "not found in the sim's code" (they may be sent indirectly).

The lesson editor then offers these as menus ("When the sim reports an event", "tell the sim"), with
"Something else…" for a name typed by hand.
