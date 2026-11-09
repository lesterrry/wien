# Launch the desktop client in development mode
run:
    pnpm --dir client dev

# Check lint, formatting, types, and run tests
test:
    pnpm --dir client test

# Build the desktop client
build:
    pnpm --dir client build
