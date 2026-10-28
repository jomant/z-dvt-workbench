using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

sealed class Program
{
    static int Main()
    {
        using (new Mutex(false, "Z-DVT-Workbench"))
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string node = Path.Combine(root, "runtime", "node.exe");
            string app = Path.Combine(root, "app");
            string server = Path.Combine(app, "src", "server.js");
            if (!File.Exists(node) || !File.Exists(server))
            {
                Console.Error.WriteLine("Z-DVT Workbench is missing its program files.");
                return 1;
            }

            var start = new ProcessStartInfo();
            start.FileName = node;
            start.Arguments = "\"" + server + "\"";
            start.WorkingDirectory = app;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;

            Process child;
            try
            {
                child = Process.Start(start);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
                return 1;
            }

            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
