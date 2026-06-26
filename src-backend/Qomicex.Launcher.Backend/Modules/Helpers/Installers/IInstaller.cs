using System;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Installers
{
    public interface IInstaller
    {
        Task InstallAsync(string versionId, string inheritsFromJson, string? para1, string? para2, string? para3, string? para4);
    }
}
