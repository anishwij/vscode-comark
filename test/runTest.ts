import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests
} from '@vscode/test-electron';

// Parse command line arguments
const args = process.argv.slice(2);
const manualMode = args.includes('--manual');

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index.js');
    const vsixPath = path.resolve(__dirname, `../../mdc-${process.env.npm_package_version}.vsix`);
    
    // Verify VSIX file exists
    if (!fs.existsSync(vsixPath)) {
      console.error(`VSIX file not found at: ${vsixPath}`);
      console.error('Please run "pnpm generate" first to create the VSIX package');
      process.exit(1);
    }
    
    console.log(`📦 VSIX package found: ${vsixPath}`);
    
    if (manualMode) {
      console.log('🔧 Manual mode enabled - VS Code will stay open for manual testing');
      console.log('   Close the VS Code window when you\'re done testing');
    }
    
    let vscodeExecutablePath = await downloadAndUnzipVSCode();
    // Recent macOS builds use Code rather than Electron as their executable name.
    if (!fs.existsSync(vscodeExecutablePath) && process.platform === 'darwin') {
      const codePath = path.join(path.dirname(vscodeExecutablePath), 'Code');
      if (fs.existsSync(codePath)) { vscodeExecutablePath = codePath; }
    }
    const testRoot = path.resolve(extensionDevelopmentPath, '.vscode-test');
    const userDataDir = fs.mkdtempSync(path.join(testRoot, 'user-data-'));
    const extensionsDir = fs.mkdtempSync(path.join(testRoot, 'extensions-'));
    const isolatedArgs = ['--user-data-dir=' + userDataDir, '--extensions-dir=' + extensionsDir];
    const workspaceDir = fs.mkdtempSync(path.join(testRoot, 'workspace-'));
    fs.copyFileSync(path.join(extensionDevelopmentPath, 'test/fixtures/component-metadata.json'), path.join(workspaceDir, 'component-metadata.json'));
    console.log(`✓ VS Code downloaded: ${vscodeExecutablePath}`);
    
    const [cliPath] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    const args = isolatedArgs;

    console.log(`🔧 Installing extension from VSIX...`);
    console.log(`   Command: ${cliPath} ${[...args, '--install-extension', vsixPath].join(' ')}`);
    
    // Install the VSIX extension
    const installResult = cp.spawnSync(
      cliPath,
      [...args, '--install-extension', vsixPath],
      {
        encoding: 'utf-8',
        stdio: 'inherit'
      }
    );

    if (installResult.error) {
      console.error('❌ Failed to install extension:', installResult.error);
      process.exit(1);
    }

    if (installResult.status !== 0) {
      console.error(`❌ Extension installation failed with exit code ${installResult.status}`);
      process.exit(1);
    }

    console.log('✓ Extension installed successfully');

    // Verify extension is installed by listing extensions
    console.log('🔍 Verifying extension installation...');
    const listResult = cp.spawnSync(
      cliPath,
      [...args, '--list-extensions'],
      {
        encoding: 'utf-8',
        stdio: 'pipe'
      }
    );

    if (listResult.stdout && listResult.stdout.toLowerCase().includes('nuxt.mdc')) {
      console.log('✓ Extension "Nuxt.mdc" confirmed in installed extensions');
    } else {
      console.warn('⚠️  Warning: Extension "Nuxt.mdc" not found in extension list');
      console.log('Installed extensions:', listResult.stdout);
    }

    if (manualMode) {
      // In manual mode, launch VS Code and wait for user to close it
      console.log('\n🚀 Launching VS Code for manual testing...');
      console.log('   Opening a sample MDC file for testing');
      console.log('   The editor will stay open - close it when done testing\n');
      
      // Create a sample MDC file for testing
      const sampleMdcPath = path.resolve(__dirname, '../../test-sample.mdc');
      const sampleContent = `# MDC Extension Manual Test

This is a sample MDC file for manual testing.

## Test Features:

1. **Syntax Highlighting**: Check if MDC syntax is properly highlighted
2. **Code Folding**: Try folding the container below
3. **Commands**: Try the command palette (Cmd/Ctrl+Shift+P) and search for "MDC"

::container
This is a container component.
You should be able to fold this section.
::

::callout{type="info"}
This is a callout with props
::

## Configuration

Try these settings in VS Code settings (JSON):
- \`mdc.enableFormatting\`: Enable/disable formatting
- \`mdc.debug\`: Enable debug logging

Close this window when you're done testing!
`;
      
      fs.writeFileSync(sampleMdcPath, sampleContent);
      
      // Launch VS Code with the sample file and wait for it to close
      const launchArgs = [
        ...isolatedArgs,
        '--extensionDevelopmentPath=' + extensionDevelopmentPath,
        sampleMdcPath,
        '--wait' // This makes the process wait until the window is closed
      ];
      
      const manualTestProcess = cp.spawnSync(
        vscodeExecutablePath,
        launchArgs,
        {
          encoding: 'utf-8',
          stdio: 'inherit'
        }
      );
      
      // Clean up sample file
      if (fs.existsSync(sampleMdcPath)) {
        fs.unlinkSync(sampleMdcPath);
      }
      
      if (manualTestProcess.status === 0) {
        console.log('\n✓ Manual testing completed');
      } else {
        console.log('\n⚠️  VS Code closed with status:', manualTestProcess.status);
      }
    } else {
      // Run the automated extension tests
      console.log('🧪 Running extension tests...');
      const installedExtension = fs.readdirSync(extensionsDir).find(name => name.toLowerCase().startsWith('nuxt.mdc-'));
      if (!installedExtension) { throw new Error('The packaged MDC extension was not installed'); }
      await runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath: path.join(extensionsDir, installedExtension),
        extensionTestsPath,
        launchArgs: [workspaceDir, ...isolatedArgs]
      });
      
      console.log('✓ All tests completed successfully');
    }
  } catch (err) {
    console.error('❌ Failed to run tests:', err);
    process.exit(1);
  }
}

main(); 