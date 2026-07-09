using System.Diagnostics;

namespace Qomicex.Launcher.Backend.Common;

public static class FileTrash
{
    public static void MoveDirectory(string dir, string gameDir)
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(
                    dir,
                    Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs,
                    Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
            }
            else if (OperatingSystem.IsLinux())
            {
                var proc = Process.Start(new ProcessStartInfo
                {
                    FileName = "gio",
                    Arguments = $"trash \"{dir}\"",
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
                if (proc is not null)
                {
                    proc.WaitForExit();
                    if (proc.ExitCode != 0 && Directory.Exists(dir))
                        FallbackMove(dir, gameDir);
                }
            }
            else
            {
                FallbackMove(dir, gameDir);
            }
        }
        catch
        {
            try { FallbackMove(dir, gameDir); } catch { }
        }
    }

    public static void MoveFile(string file, string gameDir)
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(
                    file,
                    Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs,
                    Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
            }
            else if (OperatingSystem.IsLinux())
            {
                var proc = Process.Start(new ProcessStartInfo
                {
                    FileName = "gio",
                    Arguments = $"trash \"{file}\"",
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
                if (proc is not null)
                {
                    proc.WaitForExit();
                    if (proc.ExitCode != 0 && System.IO.File.Exists(file))
                        FallbackMove(file, gameDir);
                }
            }
            else
            {
                FallbackMove(file, gameDir);
            }
        }
        catch
        {
            try { FallbackMove(file, gameDir); } catch { }
        }
    }

    private static void FallbackMove(string path, string gameDir)
    {
        var trashRoot = Path.Combine(gameDir, ".trash");
        Directory.CreateDirectory(trashRoot);
        var name = Path.GetFileName(path);
        var dest = Path.Combine(trashRoot, name);
        if (Directory.Exists(dest) || System.IO.File.Exists(dest))
            dest = Path.Combine(trashRoot, $"{name}_{DateTime.Now:yyyyMMddHHmmss}");
        if (Directory.Exists(path))
            Directory.Move(path, dest);
        else
            System.IO.File.Move(path, dest);
    }
}
