# euclid — technical fixture

Original technical fixture, not official Strudel documentation. Source-only examples; no execution claimed.

## Pattern.euclid(pulses, steps)

`euclid(pulses, steps)` distributes a number of pulses across a number of steps. Three pulses in eight steps is a useful rhythmic starting point. Rotation can change the starting position; do not infer a specific phase from the name alone.

```javascript
s("bd").euclid(3, 8)
```
