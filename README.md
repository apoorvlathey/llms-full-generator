# llms-full.txt Generator

A tool to index website content and save it as markdown files, optimized for LLM consumption. It crawls through all the pages on a given domain, converts the content to markdown, and saves both individual page files and a consolidated content file.

## Features

- Crawls all pages within a domain
- Converts HTML content to Markdown
- Saves individual page files in a directory structure matching the URL paths
- Creates a consolidated `llms-full.txt` file with all content
- Beautiful progress bars and terminal output
- Handles relative and absolute URLs
- Removes unnecessary elements like scripts, styles, and iframes
- Optimized output formatting for LLM consumption:
  - No extra whitespace
  - Clean section breaks
  - Smart handling of headings and lists
  - Consistent paragraph spacing

## Installation

```bash
# Install dependencies
pnpm install

# Build the project
pnpm build
```

## Usage

The tool provides two main commands:

### 1. Crawl a website

```bash
# Crawl a website and generate markdown files
pnpm start crawl <url>

# Example
pnpm start crawl https://example.com
```

### 2. Generate consolidated file from existing markdown

If you already have the markdown files in the output directory, you can regenerate the `llms-full.txt` file without crawling:

```bash
# Generate llms-full.txt from existing markdown files
pnpm start generate <domain>

# Example
pnpm start generate example.com
```

## Output Structure

```
output/
└── example.com/
    ├── index.md
    ├── about.md
    ├── docs/
    │   ├── getting-started.md
    │   └── api-reference.md
    └── llms-full.txt
```

The tool will create:

- A folder named after the domain
- Individual markdown files for each page, maintaining the URL path structure
- A `llms-full.txt` file containing all content in an LLM-friendly format
