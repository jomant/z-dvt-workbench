using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public sealed class MakeIcon
{
    public static void Main(string[] args)
    {
        using (Bitmap bmp = new Bitmap(256, 256, PixelFormat.Format32bppArgb))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.FromArgb(7, 20, 40));
            using (Pen pen = new Pen(Color.FromArgb(186, 214, 255), 10))
            {
                g.DrawEllipse(pen, 28, 28, 200, 200);
            }
            using (SolidBrush u = new SolidBrush(Color.FromArgb(126, 182, 255)))
            using (SolidBrush v = new SolidBrush(Color.FromArgb(240, 194, 122)))
            using (SolidBrush w = new SolidBrush(Color.FromArgb(142, 224, 176)))
            {
                g.FillEllipse(u, 108, 48, 40, 40);
                g.FillEllipse(v, 168, 148, 40, 40);
                g.FillEllipse(w, 48, 148, 40, 40);
            }
            using (MemoryStream png = new MemoryStream())
            {
                bmp.Save(png, ImageFormat.Png);
                byte[] data = png.ToArray();
                using (FileStream fs = File.Create(args[0]))
                using (BinaryWriter bw = new BinaryWriter(fs))
                {
                    bw.Write((ushort)0);
                    bw.Write((ushort)1);
                    bw.Write((ushort)1);
                    bw.Write((byte)0);
                    bw.Write((byte)0);
                    bw.Write((byte)0);
                    bw.Write((byte)0);
                    bw.Write((ushort)1);
                    bw.Write((ushort)32);
                    bw.Write(data.Length);
                    bw.Write(22);
                    bw.Write(data);
                }
            }
        }
    }
}
