import axios from "axios";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import * as fs from "fs/promises";
import * as path from "path";
import URLParse from "url-parse";
import cliProgress, { Options, Params } from "cli-progress";
import colors from "colors";
import { Command } from "commander";

interface PageData {
  url: string;
  content: string;
  title: string;
}

interface FailedPage {
  url: string;
  reason: string;
  referrer: string;
}

interface ProgressBarOptions {
  barCompleteString: string;
  barIncompleteString: string;
  barsize: number;
}

interface ProgressBarParams {
  progress: number;
  percentage: number;
  value: number;
  total: number;
}

interface ProgressBarPayload {
  status?: string;
}

class Limiter {
  private running = 0;
  private queue: (() => Promise<void>)[] = [];

  constructor(private maxConcurrent: number) {}

  async add<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.maxConcurrent) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) next();
      }
    }
  }
}

class SiteIndexer {
  private visited = new Set<string>();
  private queue: string[] = [];
  private baseUrl: string = "";
  private baseDomain: string = "";
  private basePath: string = "";
  private turndown: TurndownService;
  private progressBar: cliProgress.MultiBar;
  private pagesBar: cliProgress.SingleBar;
  private currentBar: cliProgress.SingleBar;
  private successfulPages = 0;
  private failedPages: FailedPage[] = [];
  private limiter: Limiter;
  private referrerMap = new Map<string, string>(); // Track referrers for each URL

  constructor(startUrl: string, skipUrlInit = false) {
    if (!skipUrlInit) {
      const parsedUrl = new URLParse(startUrl);
      this.baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
      this.baseDomain = parsedUrl.host;
      this.basePath = parsedUrl.pathname;
      if (!this.basePath.endsWith("/")) {
        this.basePath += "/";
      }
    }

    this.turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });

    this.progressBar = new cliProgress.MultiBar({
      format: (
        options: Options,
        params: Params,
        payload: { status?: string }
      ) => {
        const barSize = options.barsize || 40;
        const progress = Math.floor(params.progress * barSize);
        const bar =
          (options.barCompleteString || "").substring(0, progress) +
          (options.barIncompleteString || "").substring(progress);

        let barColor = colors.cyan; // default processing color
        if (payload.status?.startsWith("✅")) {
          barColor = colors.green;
        } else if (payload.status?.startsWith("❌")) {
          barColor = colors.red;
        }

        return `${barColor(bar)} | ${Math.floor(params.progress * 100)}% | ${
          params.value
        }/${params.total} | ${payload.status || ""}`;
      },
      barCompleteChar: "\u2588",
      barIncompleteChar: "\u2591",
      clearOnComplete: false,
      hideCursor: true,
    });

    this.pagesBar = this.progressBar.create(0, 0, { status: "Pages Found" });
    this.currentBar = this.progressBar.create(1, 0, { status: "Processing" });
    this.limiter = new Limiter(5); // Process 5 pages concurrently
  }

  private normalizeUrl(url: string): string {
    try {
      // Remove hash fragment first
      url = url.split("#")[0];

      const basePathParts = this.basePath.split("/").filter(Boolean);
      const baseContextPath = basePathParts.slice(0, -1).join("/"); // Remove last part (version/date/etc)

      // Handle absolute URLs
      if (url.startsWith("http://") || url.startsWith("https://")) {
        const parsedUrl = new URLParse(url);
        if (parsedUrl.host === this.baseDomain) {
          const urlPathParts = parsedUrl.pathname.split("/").filter(Boolean);

          // If URL starts with same context as base path
          if (urlPathParts[0] === basePathParts[0]) {
            // Check if it's referencing a different version/date
            const potentialVersion = urlPathParts.slice(1).find((part) =>
              // Look for parts that could be versions, dates, etc.
              /^v\d|^\d{4}/.test(part)
            );

            if (potentialVersion) {
              // It has its own version/date context, reconstruct URL with that
              const newPath = `/${urlPathParts
                .slice(0, urlPathParts.indexOf(potentialVersion) + 1)
                .join("/")}/${urlPathParts
                .slice(urlPathParts.indexOf(potentialVersion) + 1)
                .join("/")}`;
              parsedUrl.set("pathname", newPath);
              return parsedUrl.toString();
            } else {
              // No version/date found, use current context
              parsedUrl.set(
                "pathname",
                `${this.basePath}${urlPathParts.slice(1).join("/")}`
              );
              return parsedUrl.toString();
            }
          }
        }
        return url;
      }

      // Handle protocol-relative URLs
      if (url.startsWith("//")) {
        const parsedBase = new URLParse(this.baseUrl);
        return `${parsedBase.protocol}${url}`;
      }

      // Handle root-relative URLs
      if (url.startsWith("/")) {
        const urlPathParts = url.split("/").filter(Boolean);

        // If URL starts with same context as base path
        if (urlPathParts[0] === basePathParts[0]) {
          // Check if it's referencing a different version/date
          const potentialVersion = urlPathParts.slice(1).find((part) =>
            // Look for parts that could be versions, dates, etc.
            /^v\d|^\d{4}/.test(part)
          );

          if (potentialVersion) {
            // It has its own version/date context, keep as is
            return `${this.baseUrl}${url}`;
          } else {
            // No version/date found, use current context
            return `${this.baseUrl}${this.basePath}${urlPathParts
              .slice(1)
              .join("/")}`;
          }
        }
        return `${this.baseUrl}${url}`;
      }

      // Handle relative URLs
      const fullBasePath = `${this.baseUrl}${this.basePath}`;
      return new URL(url, fullBasePath).toString();
    } catch {
      return url;
    }
  }

  private isValidUrl(url: string): boolean {
    try {
      // Remove hash fragment first
      url = url.split("#")[0];
      const parsed = new URLParse(url);

      // Allow subdomains of the base domain
      const baseDomainParts = this.baseDomain.split(".");
      const urlDomainParts = parsed.host.split(".");

      // Check if URL domain ends with base domain
      if (baseDomainParts.length <= urlDomainParts.length) {
        const urlEndParts = urlDomainParts.slice(-baseDomainParts.length);
        return urlEndParts.join(".") === this.baseDomain;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async extractLinks($: cheerio.CheerioAPI): Promise<string[]> {
    const links: string[] = [];
    $("a").each((_, element) => {
      const href = $(element).attr("href");
      if (
        href &&
        !href.startsWith("#") &&
        !href.startsWith("mailto:") &&
        !href.startsWith("tel:") &&
        !href.includes("javascript:")
      ) {
        try {
          const normalizedUrl = this.normalizeUrl(href);
          if (
            this.isValidUrl(normalizedUrl) &&
            !this.visited.has(normalizedUrl)
          ) {
            links.push(normalizedUrl);
          }
        } catch (error) {
          console.error(
            colors.yellow(`\nError normalizing URL ${href}: ${error}`)
          );
        }
      }
    });
    return [...new Set(links)]; // Remove duplicates
  }

  // Add delay helper
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async processPage(url: string): Promise<PageData | null> {
    let $ = null;
    let title = url;
    let content = "";

    try {
      this.currentBar.update(0, { status: `⏳ Processing ${url}` });
      const response = await axios.get(url);
      $ = cheerio.load(response.data);

      // Remove unnecessary elements
      $("script, style, nav, footer, header, iframe").remove();

      title = $("title").text() || url;
      content = this.turndown.turndown($("body").html() || "");
      this.currentBar.update(0, { status: `✅ Processed ${url}` });
      await this.delay(100); // Add 100ms delay to make emoji visible
    } catch (error) {
      // Track failed pages with reason and referrer
      this.failedPages.push({
        url,
        reason: error instanceof Error ? error.message : "Unknown error",
        referrer: this.referrerMap.get(url) || "Initial URL",
      });
      this.currentBar.update(0, { status: `❌ Failed ${url}` });
      await this.delay(100); // Add 100ms delay to make emoji visible
      return null;
    }

    // Extract links even if page processing failed
    if ($) {
      const newLinks = await this.extractLinks($);
      // Store current URL as referrer for these links
      const currentUrl = url;
      for (const link of newLinks) {
        if (!this.referrerMap.has(link)) {
          this.referrerMap.set(link, currentUrl);
        }
      }
      this.queue.push(...newLinks);
      this.pagesBar.setTotal(this.queue.length + this.visited.size);
    }

    return { url, content, title };
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
      const batchSize = Math.min(5, this.queue.length);
      const batch = this.queue.splice(0, batchSize);

      const results = await Promise.all(
        batch.map((url) => {
          if (this.visited.has(url)) return Promise.resolve(null);
          this.visited.add(url);
          this.pagesBar.update(this.visited.size);

          return this.limiter.add(async () => {
            const pageData = await this.processPage(url);
            if (!pageData) return null;

            const outputPath = this.getOutputFilePath(pageData.url);
            await fs.mkdir(path.dirname(outputPath), { recursive: true });
            await fs.writeFile(outputPath, pageData.content);

            return pageData;
          });
        })
      );

      for (const pageData of results) {
        if (pageData) {
          contentParts.push(
            `# ${pageData.title}\n\n${this.cleanContent(pageData.content)}`
          );
          this.successfulPages++;
        }
      }
      this.currentBar.update(1);
    }

    const fullOutputPath = path.join(
      "output",
      this.baseDomain,
      "llms-full.txt"
    );
    const finalContent = contentParts.join("\n\n").trim();
    await fs.writeFile(fullOutputPath, finalContent);

    // Save failed URLs to a separate file
    if (this.failedPages.length > 0) {
      const failedUrlsPath = path.join(
        "output",
        this.baseDomain,
        "failed-urls.json"
      );
      const failedContent = JSON.stringify(
        {
          totalFailed: this.failedPages.length,
          timestamp: new Date().toISOString(),
          failedPages: this.failedPages,
        },
        null,
        2
      );
      await fs.writeFile(failedUrlsPath, failedContent);
      console.log(colors.yellow(`Failed URLs saved to: ${failedUrlsPath}\n`));
    }

    this.progressBar.stop();
    process.stdout.write("\x1B[1A\x1B[2K".repeat(3)); // Clear the last 3 lines (2 progress bars + newline)

    console.log(
      colors.green(
        `\nIndexing complete! Processed ${this.visited.size} pages (${
          this.successfulPages
        } successful, ${this.visited.size - this.successfulPages} failed)`
      )
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
      process.stdout.write("\x1B[1A\x1B[2K".repeat(2)); // Clear the last 2 lines (progress bar + newline)

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
