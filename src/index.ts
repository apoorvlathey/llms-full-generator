import axios from "axios";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import * as fs from "fs/promises";
import * as path from "path";
import URLParse from "url-parse";
import cliProgress from "cli-progress";
import colors from "colors";
import { Command } from "commander";

interface PageData {
  url: string;
  content: string;
  title: string;
}

class SiteIndexer {
  private visited = new Set<string>();
  private queue: string[] = [];
  private baseUrl: string = "";
  private baseDomain: string = "";
  private turndown: TurndownService;
  private progressBar: cliProgress.MultiBar;
  private pagesBar: cliProgress.SingleBar;
  private currentBar: cliProgress.SingleBar;

  constructor(startUrl: string, skipUrlInit = false) {
    if (!skipUrlInit) {
      const parsedUrl = new URLParse(startUrl);
      this.baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
      this.baseDomain = parsedUrl.host;
    }

    this.turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });

    this.progressBar = new cliProgress.MultiBar({
      format:
        colors.cyan("{bar}") + " | {percentage}% | {value}/{total} | {status}",
      barCompleteChar: "\u2588",
      barIncompleteChar: "\u2591",
      clearOnComplete: false,
      hideCursor: true,
    });

    this.pagesBar = this.progressBar.create(0, 0, { status: "Pages Found" });
    this.currentBar = this.progressBar.create(1, 0, { status: "Current Page" });
  }

  private isValidUrl(url: string): boolean {
    try {
      const parsed = new URLParse(url);
      return parsed.host === this.baseDomain;
    } catch {
      return false;
    }
  }

  private normalizeUrl(url: string): string {
    if (url.startsWith("/")) {
      return `${this.baseUrl}${url}`;
    }
    return url;
  }

  private async extractLinks($: cheerio.CheerioAPI): Promise<string[]> {
    const links: string[] = [];
    $("a").each((_, element) => {
      const href = $(element).attr("href");
      if (href && !href.startsWith("#") && !href.startsWith("mailto:")) {
        const normalizedUrl = this.normalizeUrl(href);
        if (
          this.isValidUrl(normalizedUrl) &&
          !this.visited.has(normalizedUrl)
        ) {
          links.push(normalizedUrl);
        }
      }
    });
    return links;
  }

  private async processPage(url: string): Promise<PageData | null> {
    try {
      const response = await axios.get(url);
      const $ = cheerio.load(response.data);

      // Remove unnecessary elements
      $("script, style, nav, footer, header, iframe").remove();

      const title = $("title").text() || url;
      const content = this.turndown.turndown($("body").html() || "");

      const newLinks = await this.extractLinks($);
      this.queue.push(...newLinks);
      this.pagesBar.setTotal(this.queue.length + this.visited.size);

      return { url, content, title };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(colors.red(`\nError processing ${url}: ${errorMessage}`));
      return null;
    }
  }

  private getOutputFilePath(url: string): string {
    const parsedUrl = new URLParse(url);
    let pathName = parsedUrl.pathname;

    if (pathName === "/") {
      pathName = "/index";
    }

    if (!pathName.endsWith(".md")) {
      pathName = `${pathName}.md`;
    }

    return path.join("output", this.baseDomain, pathName);
  }

  private cleanContent(content: string): string {
    return content
      .trim()
      .split("\n")
      .map((line) => line.trim()) // Trim each line
      .filter((line, index, arr) => {
        // Keep lines that have content
        if (line) return true;
        // Keep single empty line between paragraphs, but not after headings or list items
        if (index > 0 && index < arr.length - 1) {
          const prevLine = arr[index - 1];
          const nextLine = arr[index + 1];
          return (
            prevLine &&
            nextLine &&
            !prevLine.startsWith("#") && // No empty line after headings
            !prevLine.startsWith("*") && // No empty line after list items
            !prevLine.startsWith("-") && // No empty line after list items
            !nextLine.startsWith("#") && // No empty line before headings
            !nextLine.startsWith("*") && // No empty line before list items
            !nextLine.startsWith("-")
          ); // No empty line before list items
        }
        return false;
      })
      .join("\n");
  }

  public async start(): Promise<void> {
    this.queue.push(this.baseUrl);
    const contentParts: string[] = [];

    console.log(colors.green(`\nStarting to index ${this.baseUrl}`));

    while (this.queue.length > 0) {
      const url = this.queue.shift()!;
      if (this.visited.has(url)) continue;

      this.visited.add(url);
      this.pagesBar.update(this.visited.size);
      this.currentBar.update(0, { status: `Processing ${url}` });

      const pageData = await this.processPage(url);
      if (!pageData) continue;

      const outputPath = this.getOutputFilePath(pageData.url);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, pageData.content);

      contentParts.push(
        `# ${pageData.title}\n\n${this.cleanContent(pageData.content)}`
      );
      this.currentBar.update(1);
    }

    const fullOutputPath = path.join(
      "output",
      this.baseDomain,
      "llms-full.txt"
    );
    const finalContent = contentParts.join("\n\n").trim();
    await fs.writeFile(fullOutputPath, finalContent);

    this.progressBar.stop();
    console.log(
      colors.green(`\nIndexing complete! Processed ${this.visited.size} pages`)
    );
    console.log(colors.cyan(`Full content saved to: ${fullOutputPath}`));
  }

  public async generateLlmsFromExisting(domain: string): Promise<void> {
    const domainPath = path.join("output", domain);

    try {
      const contentParts: string[] = [];
      console.log(
        colors.green(
          `\nGenerating llms-full.txt from existing files in ${domainPath}`
        )
      );

      // Create a progress bar for processing files
      const bar = new cliProgress.SingleBar({
        format:
          colors.cyan("{bar}") +
          " | {percentage}% | {value}/{total} Files | {file}",
        barCompleteChar: "\u2588",
        barIncompleteChar: "\u2591",
      });

      // Recursively get all .md files
      const getFiles = async (dir: string): Promise<string[]> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(
          entries.map(async (entry) => {
            const fullPath = path.join(dir, entry.name);
            return entry.isDirectory() ? getFiles(fullPath) : fullPath;
          })
        );
        return files.flat().filter((file) => file.endsWith(".md"));
      };

      const files = await getFiles(domainPath);
      bar.start(files.length, 0, { file: "" });

      for (const [index, file] of files.entries()) {
        const content = await fs.readFile(file, "utf-8");
        const relativePath = path.relative(domainPath, file);
        const title = relativePath.replace(/\.md$/, "").replace(/\//g, " - ");

        // Add a newline before each new section except the first one
        if (index > 0) contentParts.push("");
        contentParts.push(`# ${title}\n${this.cleanContent(content)}`);
        bar.update(index + 1, { file: relativePath });
      }

      const fullOutputPath = path.join(domainPath, "llms-full.txt");
      const finalContent = contentParts.join("\n");
      await fs.writeFile(fullOutputPath, finalContent);

      bar.stop();
      console.log(colors.green(`\nSuccessfully generated ${fullOutputPath}`));
      console.log(colors.cyan(`Processed ${files.length} files`));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(
        colors.red(`\nError generating llms-full.txt: ${errorMessage}`)
      );
      throw error;
    }
  }
}

const program = new Command();

program
  .name("site-indexer")
  .description("Index website content and save as markdown")
  .version("1.0.0");

program
  .command("crawl")
  .description("Crawl a website and generate markdown files")
  .argument("<url>", "URL to start indexing from")
  .action(async (url: string) => {
    const indexer = new SiteIndexer(url);
    await indexer.start();
  });

program
  .command("generate")
  .description("Generate llms-full.txt from existing markdown files")
  .argument("<domain>", "Domain name of the folder in output directory")
  .action(async (domain: string) => {
    const indexer = new SiteIndexer("", true); // Skip URL initialization
    await indexer.generateLlmsFromExisting(domain);
  });

program.parse();
