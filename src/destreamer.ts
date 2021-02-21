import { argv } from './CommandLineParser';
import { ERROR_CODE } from './Errors';
import { setProcessEvents } from './Events';
import { logger } from './Logger';
import { getPuppeteerChromiumPath } from './PuppeteerHelper';
import { drawThumbnail } from './Thumbnail';
import { TokenCache, refreshSession } from './TokenCache';
import { Video, Session } from './Types';
import { checkRequirements, ffmpegTimemarkToChunk, parseInputFile, parseCLIinput } from './Utils';
import { getVideoInfo, createUniquePath } from './VideoUtils';

import cliProgress from 'cli-progress';
import fs from 'fs';
import isElevated from 'is-elevated';
import puppeteer from 'puppeteer';
import { ApiClient } from './ApiClient';


const { FFmpegCommand, FFmpegInput, FFmpegOutput } = require('@tedconf/fessonia')();
const tokenCache: TokenCache = new TokenCache();


async function init(): Promise<void> {
    setProcessEvents(); // must be first!

    if (argv.verbose) {
        logger.level = 'verbose';
    }

    if (await isElevated()) {
        process.exit(ERROR_CODE.ELEVATED_SHELL);
    }

    checkRequirements();

    if (argv.username) {
        logger.info(`Username: ${argv.username}`);
    }

    if (argv.simulate) {
        logger.warn('Simulate mode, there will be no video downloaded. \n');
    }
}


async function DoInteractiveLogin(url: string, username?: string, password?: string): Promise<Session> {

    logger.info('Launching headless Chrome to perform the OpenID Connect dance...');

    const browser: puppeteer.Browser = await puppeteer.launch({
        executablePath: getPuppeteerChromiumPath(),
        headless: true,
        userDataDir: (argv.keepLoginCookies) ? argv.chromeDataFolder : undefined,
        args: [
            '--disable-dev-shm-usage',
            '--fast-start',
            '--no-sandbox'
        ]
    });
    const page: puppeteer.Page = (await browser.pages())[0];

    logger.info('Navigating to login page...');
    await page.goto(url, { waitUntil: 'load' });
    
    if(page.url().startsWith('https://login.microsoftonline.com')) {
        try {
            if(!username || !password)
                throw new Error('Invalid login credentials');

            await page.waitForSelector('input[type="email"]', { timeout: 3000 });
            await page.keyboard.type(username);
            await page.click('input[type="submit"]');

            await browser.waitForTarget((target: puppeteer.Target) => target.url().startsWith('https://logon.ms.cvut.cz'), { timeout: 15000 });
            await page.waitForSelector('input[type="password"]', { timeout: 3000 });
            await page.keyboard.type(password);
            await page.click('#submitButton');

            await browser.waitForTarget((target: puppeteer.Target) => target.url().startsWith('https://login.microsoftonline.com/'), { timeout: 15000 });
            await page.waitForSelector('input[type="submit"]', { timeout: 3000 });
            await page.click('input[type="submit"]');
        }
        catch (e) {
            logger.error("Invalid login");
            process.exit(ERROR_CODE.NO_SESSION_INFO);
        }
    }

    await browser.waitForTarget((target: puppeteer.Target) => target.url().endsWith('microsoftstream.com/'), { timeout: 15000 });
    logger.info('We are logged in.');

    let session: Session | null = null;
    let tries = 1;
    while (!session) {
        try {
            let sessionInfo: any;
            session = await page.evaluate(
                () => {
                    return {
                        AccessToken: sessionInfo.AccessToken,
                        ApiGatewayUri: sessionInfo.ApiGatewayUri,
                        ApiGatewayVersion: sessionInfo.ApiGatewayVersion
                    };
                }
            );
        }
        catch (error) {
            if (tries > 5) {
                process.exit(ERROR_CODE.NO_SESSION_INFO);
            }

            session = null;
            tries++;
            await page.waitFor(3000);
        }
    }

    tokenCache.Write(session);
    logger.info('Wrote access token to token cache.');
    logger.info("At this point Chromium's job is done, shutting it down...\n");

    await browser.close();

    return session;
}


async function downloadVideo(videoGUIDs: Array<string>, outputDirectories: Array<string>, session: Session): Promise<void> {

    logger.info('Fetching videos info... \n');
    const videos: Array<Video> = createUniquePath(
        await getVideoInfo(videoGUIDs, session, argv.closedCaptions),
        outputDirectories, argv.outputTemplate, argv.format, argv.skip
    );

    if (argv.simulate) {
        videos.forEach((video: Video) => {
            logger.info(
                '\nTitle:          '.green + video.title +
                '\nOutPath:        '.green + video.outPath +
                '\nPublished Date: '.green + video.publishDate +
                '\nPlayback URL:   '.green + video.playbackUrl +
                ((video.captionsUrl) ? ('\nCC URL:         '.green + video.captionsUrl) : '')
            );
        });

        return;
    }

    for (const [index, video] of videos.entries()) {

        if (argv.skip && fs.existsSync(video.outPath)) {
            logger.info(`File already exists, skipping: ${video.outPath} \n`);
            continue;
        }

        if (argv.keepLoginCookies && index !== 0) {
            logger.info('Trying to refresh token...');
            session = await refreshSession('https://web.microsoftstream.com/video/' + videoGUIDs[index]);
            ApiClient.getInstance().setSession(session);
        }

        const pbar: cliProgress.SingleBar = new cliProgress.SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            format: 'progress [{bar}] {percentage}% {speed} {eta_formatted}',
            // process.stdout.columns may return undefined in some terminals (Cygwin/MSYS)
            barsize: Math.floor((process.stdout.columns || 30) / 3),
            stopOnComplete: true,
            hideCursor: true,
        });

        logger.info(`\nDownloading Video: ${video.title} \n`);
        logger.verbose('Extra video info \n' +
            '\t Video m3u8 playlist URL: '.cyan + video.playbackUrl + '\n' +
            '\t Video tumbnail URL: '.cyan + video.posterImageUrl + '\n' +
            '\t Video subtitle URL (may not exist): '.cyan + video.captionsUrl + '\n' +
            '\t Video total chunks: '.cyan + video.totalChunks + '\n');

        logger.info('Spawning ffmpeg with access token and HLS URL. This may take a few seconds...\n\n');
        if (!process.stdout.columns) {
            logger.warn(
                'Unable to get number of columns from terminal.\n' +
                'This happens sometimes in Cygwin/MSYS.\n' +
                'No progress bar can be rendered, however the download process should not be affected.\n\n' +
                'Please use PowerShell or cmd.exe to run destreamer on Windows.'
            );
        }

        const headers: string = 'Authorization: Bearer ' + session.AccessToken;

        if (!argv.noExperiments) {
            await drawThumbnail(video.posterImageUrl, session);
        }

        const ffmpegInpt: any = new FFmpegInput(video.playbackUrl, new Map([
            ['headers', headers]
        ]));
        const ffmpegOutput: any = new FFmpegOutput(video.outPath, new Map([
            argv.acodec === 'none' ? ['an', null] : ['c:a', argv.acodec],
            argv.vcodec === 'none' ? ['vn', null] : ['c:v', argv.vcodec],
            ['n', null]
        ]));
        const ffmpegCmd: any = new FFmpegCommand();

        const cleanupFn: () => void = () => {
            pbar.stop();

            if (argv.noCleanup) {
                return;
            }

            try {
                fs.unlinkSync(video.outPath);
            }
            catch (e) {
                // Future handling of an error (maybe)
            }
        };

        pbar.start(video.totalChunks, 0, {
            speed: '0'
        });

        // prepare ffmpeg command line
        ffmpegCmd.addInput(ffmpegInpt);
        ffmpegCmd.addOutput(ffmpegOutput);
        if (argv.closedCaptions && video.captionsUrl) {
            const captionsInpt: any = new FFmpegInput(video.captionsUrl, new Map([
                ['headers', headers]
            ]));

            ffmpegCmd.addInput(captionsInpt);
        }

        ffmpegCmd.on('update', async (data: any) => {
            const currentChunks: number = ffmpegTimemarkToChunk(data.out_time);

            pbar.update(currentChunks, {
                speed: data.bitrate
            });

            // Graceful fallback in case we can't get columns (Cygwin/MSYS)
            if (!process.stdout.columns) {
                process.stdout.write(`--- Speed: ${data.bitrate}, Cursor: ${data.out_time}\r`);
            }
        });

        process.on('SIGINT', cleanupFn);

        // let the magic begin...
        await new Promise((resolve: any) => {
            ffmpegCmd.on('error', (error: any) => {
                cleanupFn();

                logger.error(`FFmpeg returned an error: ${error.message}`);
                process.exit(ERROR_CODE.UNK_FFMPEG_ERROR);
            });

            ffmpegCmd.on('success', () => {
                pbar.update(video.totalChunks); // set progress bar to 100%
                logger.info(`\nDownload finished: ${video.outPath} \n`);
                resolve();
            });

            ffmpegCmd.spawn();
        });

        process.removeListener('SIGINT', cleanupFn);
    }
}


async function main(): Promise<void> {
    await init(); // must be first

    let session: Session;
    // eslint-disable-next-line prefer-const
    session = tokenCache.Read() ?? await DoInteractiveLogin('https://web.microsoftstream.com/', argv.username, argv.password);

    logger.verbose('Session and API info \n' +
        '\t API Gateway URL: '.cyan + session.ApiGatewayUri + '\n' +
        '\t API Gateway version: '.cyan + session.ApiGatewayVersion + '\n');

    let videoGUIDs: Array<string>;
    let outDirs: Array<string>;

    if (argv.videoUrls) {
        logger.info('Parsing video/group urls');
        [videoGUIDs, outDirs] = await parseCLIinput(argv.videoUrls as Array<string>, argv.outputDirectory, session);
    }
    else {
        logger.info('Parsing input file');
        [videoGUIDs, outDirs] = await parseInputFile(argv.inputFile!, argv.outputDirectory, session);
    }

    logger.verbose('List of GUIDs and corresponding output directory \n' +
        videoGUIDs.map((guid: string, i: number) =>
            `\thttps://web.microsoftstream.com/video/${guid} => ${outDirs[i]} \n`).join(''));


    downloadVideo(videoGUIDs, outDirs, session);
}


main();

